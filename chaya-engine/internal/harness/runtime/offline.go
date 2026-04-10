package runtime

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// OfflineTask represents a task the PrimaryAgent can run while user is offline.
type OfflineTask struct {
	ID       string
	Type     string // "cron" / "long_running" / "persona"
	Name     string
	CronExpr string        // for cron type
	Interval time.Duration // for long_running type
	Action   func(ctx context.Context) (string, error)
}

// Notification is a pending message for when the user reconnects.
type Notification struct {
	Type      string    `json:"type"`      // task_result / cron_report / persona_greeting
	Content   string    `json:"content"`
	Priority  int       `json:"priority"`  // higher = shown first
	CreatedAt time.Time `json:"created_at"`
}

// OfflineScheduler manages tasks that run while the user is disconnected.
type OfflineScheduler struct {
	agentID string
	tasks   []OfflineTask
	pending []Notification
	mu      sync.Mutex
	cancel  context.CancelFunc
	running bool
}

func NewOfflineScheduler(agentID string) *OfflineScheduler {
	return &OfflineScheduler{agentID: agentID}
}

// AddTask registers a task.
func (s *OfflineScheduler) AddTask(task OfflineTask) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks = append(s.tasks, task)
}

// Start begins executing scheduled tasks in the background.
func (s *OfflineScheduler) Start(ctx context.Context) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	taskCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	tasks := make([]OfflineTask, len(s.tasks))
	copy(tasks, s.tasks)
	s.mu.Unlock()

	for _, task := range tasks {
		switch task.Type {
		case "long_running":
			go s.runInterval(taskCtx, task)
		case "cron":
			go s.runCron(taskCtx, task)
		case "persona":
			// Persona tasks are triggered by specific events, not scheduled
		}
	}

	slog.Info("offline scheduler started", "agent", s.agentID, "tasks", len(tasks))
}

// Stop halts all running tasks.
func (s *OfflineScheduler) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	s.running = false
}

// HasTasks returns whether any tasks are registered.
func (s *OfflineScheduler) HasTasks() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.tasks) > 0
}

// Flush returns all pending notifications and clears the queue.
func (s *OfflineScheduler) Flush() []Notification {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Notification, len(s.pending))
	copy(out, s.pending)
	s.pending = nil

	// Sort by priority descending
	sort.Slice(out, func(i, j int) bool {
		return out[i].Priority > out[j].Priority
	})
	return out
}

// AddNotification queues a notification.
func (s *OfflineScheduler) AddNotification(n Notification) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n.CreatedAt = time.Now()
	s.pending = append(s.pending, n)
}

func (s *OfflineScheduler) runInterval(ctx context.Context, task OfflineTask) {
	ticker := time.NewTicker(task.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			result, err := task.Action(ctx)
			if err != nil {
				slog.Warn("offline task error", "task", task.Name, "err", err)
				continue
			}
			if result != "" {
				s.AddNotification(Notification{
					Type:     "task_result",
					Content:  result,
					Priority: 1,
				})
			}
		case <-ctx.Done():
			return
		}
	}
}

func (s *OfflineScheduler) runCron(ctx context.Context, task OfflineTask) {
	// Simplified cron: parse hour from "0 9 * * *" → run daily at that hour
	// Full cron parsing would use robfig/cron, but keeping it simple for now
	for {
		select {
		case <-time.After(1 * time.Hour): // check every hour
			// TODO: proper cron evaluation
			result, err := task.Action(ctx)
			if err != nil {
				slog.Warn("cron task error", "task", task.Name, "err", err)
				continue
			}
			if result != "" {
				s.AddNotification(Notification{
					Type:     "cron_report",
					Content:  result,
					Priority: 0,
				})
			}
		case <-ctx.Done():
			return
		}
	}
}
