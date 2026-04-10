package api

import (
	"encoding/json"
	"net/http"
	"time"

	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

type AuthAPI struct {
	db        *gorm.DB
	jwtSecret string
	tokenTTL  time.Duration
}

type authTenant struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Plan string `json:"plan"`
}

type authUser struct {
	pgstore.User
	Tenant         authTenant `json:"tenant"`
	PrimaryAgentID string     `json:"primary_agent_id,omitempty"`
}

func RegisterAuthRoutes(r chi.Router, db *gorm.DB, jwtSecret string, tokenTTL time.Duration) {
	a := &AuthAPI{db: db, jwtSecret: jwtSecret, tokenTTL: tokenTTL}
	r.Post("/api/auth/register", a.register)
	r.Post("/api/auth/login", a.login)
}

func (a *AuthAPI) register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, M{"error": "invalid body"})
		return
	}
	if req.Email == "" || req.Password == "" {
		writeJSON(w, 400, M{"error": "email and password required"})
		return
	}

	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), 12)

	// Create default tenant
	tenant := pgstore.Tenant{Name: req.Name + "'s workspace", Plan: "free"}
	if err := a.db.Create(&tenant).Error; err != nil {
		writeJSON(w, 500, M{"error": "create tenant failed"})
		return
	}

	user := pgstore.User{
		TenantID: tenant.ID,
		Email:    req.Email,
		Name:     req.Name,
		Password: string(hash),
	}
	if err := a.db.Create(&user).Error; err != nil {
		writeJSON(w, 409, M{"error": "email already exists"})
		return
	}

	// Auto-create PrimaryAgent
	cfg, _ := json.Marshal(M{"system_prompt": defaultPrompt})
	agent := pgstore.Agent{
		UserID:    user.ID,
		Type:      "primary",
		Name:      "chaya",
		Config:    cfg,
		IsPrimary: true,
	}
	a.db.Create(&agent)

	// Auto-create default Conversation bound to PrimaryAgent
	conv := pgstore.Conversation{
		UserID: user.ID,
		Title:  "chaya",
		Type:   "agent",
	}
	a.db.Create(&conv)
	a.db.Create(&pgstore.ConversationAgent{
		ConversationID: conv.ID,
		AgentID:        agent.ID,
	})

	token := a.issueToken(user.ID, tenant.ID)
	userPayload := buildAuthUser(a.db, user, tenant)
	tenantPayload := userPayload.Tenant
	writeJSON(w, 201, M{
		"token":           token,
		"user":            userPayload,
		"tenant":          tenantPayload,
		"agent_id":        agent.ID,
		"conversation_id": conv.ID,
	})
}

func (a *AuthAPI) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, M{"error": "invalid body"})
		return
	}

	var user pgstore.User
	if err := a.db.Where("email = ?", req.Email).First(&user).Error; err != nil {
		writeJSON(w, 401, M{"error": "invalid credentials"})
		return
	}

	var tenant pgstore.Tenant
	if err := a.db.Where("id = ?", user.TenantID).First(&tenant).Error; err != nil {
		writeJSON(w, 500, M{"error": "tenant not found"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)); err != nil {
		writeJSON(w, 401, M{"error": "invalid credentials"})
		return
	}

	token := a.issueToken(user.ID, user.TenantID)
	userPayload := buildAuthUser(a.db, user, tenant)
	tenantPayload := userPayload.Tenant
	writeJSON(w, 200, M{
		"token":  token,
		"user":   userPayload,
		"tenant": tenantPayload,
	})
}

func effectiveTenantPlanForUser(user pgstore.User, tenant pgstore.Tenant) string {
	if isFounderEmail(user.Email) {
		return "ultra"
	}
	return tenant.Plan
}

func lookupPrimaryAgentConversationID(db *gorm.DB, userID string) string {
	if db == nil || userID == "" {
		return ""
	}
	var row struct {
		ConversationID string
	}
	err := db.Table("agents AS a").
		Select("ca.conversation_id").
		Joins("JOIN conversation_agents ca ON ca.agent_id = a.id").
		Where("a.user_id = ? AND a.is_primary = ?", userID, true).
		Limit(1).
		Scan(&row).Error
	if err != nil {
		return ""
	}
	return row.ConversationID
}

func buildAuthUser(db *gorm.DB, user pgstore.User, tenant pgstore.Tenant) authUser {
	effectivePlan := effectiveTenantPlanForUser(user, tenant)
	return authUser{
		User: user,
		Tenant: authTenant{
			ID:   tenant.ID,
			Name: tenant.Name,
			Plan: effectivePlan,
		},
		PrimaryAgentID: lookupPrimaryAgentConversationID(db, user.ID),
	}
}

func (a *AuthAPI) issueToken(userID, tenantID string) string {
	claims := jwt.MapClaims{
		"user_id":   userID,
		"tenant_id": tenantID,
		"exp":       time.Now().Add(a.tokenTTL).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, _ := token.SignedString([]byte(a.jwtSecret))
	return signed
}

const defaultPrompt = `You are Chaya, a friendly and capable AI assistant.`

// M is a shorthand for JSON maps.
type M map[string]any

// ── Response Codes (枚举) ──

type Code int

const (
	CodeOK           Code = 0
	CodeBadRequest   Code = 400
	CodeUnauthorized Code = 401
	CodeForbidden    Code = 403
	CodeNotFound     Code = 404
	CodeConflict     Code = 409
	CodeInternal     Code = 500

	// Business codes (1xxx)
	CodeInvalidParam  Code = 1001
	CodeAlreadyExists Code = 1002
	CodeLLMError      Code = 1101
	CodeMCPError      Code = 1102
	CodeKBError       Code = 1103
)

// Response is the standard API response envelope.
type Response struct {
	Code  Code   `json:"code"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

// OK sends {"code": 0, "data": ...}
func OK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	json.NewEncoder(w).Encode(Response{Code: CodeOK, Data: data})
}

// Fail sends {"code": xxx, "error": "..."}
func Fail(w http.ResponseWriter, code Code, msg string) {
	httpStatus := int(code)
	if httpStatus == 0 || httpStatus > 599 {
		httpStatus = 500
	}
	if httpStatus >= 1000 {
		httpStatus = 400 // business errors → HTTP 400
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(httpStatus)
	json.NewEncoder(w).Encode(Response{Code: code, Error: msg})
}

// writeJSON routes to OK or Fail based on status.
func writeJSON(w http.ResponseWriter, status int, data any) {
	if status >= 400 {
		errMsg := ""
		if m, ok := data.(M); ok {
			if e, ok := m["error"].(string); ok {
				errMsg = e
			}
		}
		Fail(w, Code(status), errMsg)
		return
	}
	OK(w, data)
}
