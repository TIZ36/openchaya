package runtime

import (
	"context"
	"log/slog"

	"github.com/chaya-ai/chaya-engine/pkg/envelope"
)

// runGenericChatMailbox handles chat for a non-primary (generic) agent bound to a conversation.
// Unlike PrimaryActor, it does not delegate or classify intent — only direct streamChat.
func runGenericChatMailbox(a *Actor, ctx context.Context) {
	slog.Info("generic chat actor started", "agent", a.AgentID, "user", a.UserID)
	defer slog.Info("generic chat actor stopped", "agent", a.AgentID)
	for {
		select {
		case env := <-a.Mailbox:
			if env == nil {
				continue
			}
			a.Touch()
			switch env.Type {
			case envelope.TypeChat:
				a.streamChat(ctx, env)
			case envelope.TypeInterrupt:
				slog.Info("generic agent interrupt (no-op mailbox)", "agent", a.AgentID)
			default:
				slog.Debug("generic agent ignored envelope", "type", env.Type, "agent", a.AgentID)
			}
		case <-ctx.Done():
			return
		}
	}
}
