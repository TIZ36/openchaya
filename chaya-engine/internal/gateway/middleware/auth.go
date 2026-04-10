package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type ctxKey string

const (
	CtxUserID   ctxKey = "user_id"
	CtxTenantID ctxKey = "tenant_id"
)

// UserID extracts user_id from request context.
func UserID(ctx context.Context) string {
	v, _ := ctx.Value(CtxUserID).(string)
	return v
}

// TenantID extracts tenant_id from request context.
func TenantID(ctx context.Context) string {
	v, _ := ctx.Value(CtxTenantID).(string)
	return v
}

// JWTAuth validates Bearer token and injects user_id/tenant_id into context.
func JWTAuth(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" {
				http.Error(w, `{"error":"missing authorization"}`, http.StatusUnauthorized)
				return
			}

			tokenStr := strings.TrimPrefix(header, "Bearer ")
			if tokenStr == header {
				http.Error(w, `{"error":"invalid authorization format"}`, http.StatusUnauthorized)
				return
			}

			token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
				return []byte(secret), nil
			})
			if err != nil || !token.Valid {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
				return
			}

			claims, ok := token.Claims.(jwt.MapClaims)
			if !ok {
				http.Error(w, `{"error":"invalid claims"}`, http.StatusUnauthorized)
				return
			}

			ctx := r.Context()
			if uid, ok := claims["user_id"].(string); ok {
				ctx = context.WithValue(ctx, CtxUserID, uid)
			}
			if tid, ok := claims["tenant_id"].(string); ok {
				ctx = context.WithValue(ctx, CtxTenantID, tid)
			}

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
