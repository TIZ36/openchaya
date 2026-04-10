package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	tempAgTTL = 30 * time.Minute
	keyPrefix = "chaya:tempag:v2:"
)

// TempAgStore handles caching for short-lived task agents.
type TempAgStore struct {
	rdb *redis.Client
}

type TempAgRecord struct {
	UserID         string `json:"u"`
	Task           string `json:"t"`
	ExpectedResult string `json:"e"`
	AgentType      string `json:"a"`
	Result         string `json:"r"`
	Timestamp      int64  `json:"ts"`
}

func NewTempAgStore(rdb *redis.Client) *TempAgStore {
	return &TempAgStore{rdb: rdb}
}

// NormalizeDelegationCacheText collapses whitespace so near-duplicate prompts share cache (semantic-lite).
func NormalizeDelegationCacheText(s string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
}

// GetTaskFingerprint generates a unique hash for a task.
func (s *TempAgStore) GetTaskFingerprint(userID, task, expected, agentType string) string {
	h := sha256.New()
	h.Write([]byte("v3"))
	h.Write([]byte(userID))
	h.Write([]byte(NormalizeDelegationCacheText(task)))
	h.Write([]byte(NormalizeDelegationCacheText(expected)))
	h.Write([]byte(agentType))
	return hex.EncodeToString(h.Sum(nil))
}

// GetResult checks Redis for a cached result.
func (s *TempAgStore) GetResult(ctx context.Context, fingerprint string) (string, bool) {
	if s.rdb == nil {
		return "", false
	}
	val, err := s.rdb.Get(ctx, keyPrefix+fingerprint).Result()
	if err != nil {
		return "", false
	}

	var rec TempAgRecord
	if err := json.Unmarshal([]byte(val), &rec); err != nil {
		return "", false
	}
	// Defensive filter: ignore empty / failed-like cached content.
	if !shouldCacheResult(rec.Result) {
		return "", false
	}
	return rec.Result, true
}

// SaveResult caches a task result in Redis.
func (s *TempAgStore) SaveResult(ctx context.Context, fingerprint string, rec TempAgRecord) error {
	if s.rdb == nil {
		return nil
	}
	rec.Timestamp = time.Now().Unix()
	buf, _ := json.Marshal(rec)
	return s.rdb.Set(ctx, keyPrefix+fingerprint, buf, tempAgTTL).Err()
}

func shouldCacheResult(result string) bool {
	r := result
	if r == "" {
		return false
	}
	// Avoid reusing degraded/failure outputs.
	if containsAny(r, []string{
		"(Error:",
		"(Error after max iterations:",
		"timed out waiting for sub-actor",
		"(Sub-agent timed out)",
		"[错误]",
		"无法产生回复",
	}) {
		return false
	}
	return true
}

func containsAny(s string, needles []string) bool {
	for _, n := range needles {
		if n != "" && strings.Contains(s, n) {
			return true
		}
	}
	return false
}
