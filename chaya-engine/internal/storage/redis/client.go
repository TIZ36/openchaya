package redis

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/chaya-ai/chaya-engine/internal"
	"github.com/redis/go-redis/v9"
)

func Connect(cfg internal.RedisConfig) (*redis.Client, error) {
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.Addr,
		Password: cfg.Password,
		DB:       cfg.DB,
	})

	if err := client.Ping(context.Background()).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	slog.Info("redis connected", "addr", cfg.Addr)
	return client, nil
}
