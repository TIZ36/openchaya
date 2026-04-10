package runtime

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type ExecutionLogEntry struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Type      string `json:"type"`
	Message   string `json:"message"`
	Detail    string `json:"detail,omitempty"`
	Duration  int64  `json:"duration,omitempty"`
	AgentID   string `json:"agent_id,omitempty"`
	AgentName string `json:"agent_name,omitempty"`
	MessageID string `json:"message_id,omitempty"`
}

type executionTrace struct {
	MessageID string
	Logs      []ExecutionLogEntry
}

var (
	executionTraceMu      sync.Mutex
	executionTraces       = make(map[string]*executionTrace)
	executionLogIDCounter uint64
)

func nextExecutionLogID() string {
	id := atomic.AddUint64(&executionLogIDCounter, 1)
	return fmt.Sprintf("exec-%d-%d", time.Now().UnixMilli(), id)
}

func resetExecutionTrace(convID string) {
	if convID == "" {
		return
	}
	executionTraceMu.Lock()
	defer executionTraceMu.Unlock()
	executionTraces[convID] = &executionTrace{}
}

func appendExecutionTrace(convID string, entry ExecutionLogEntry) ExecutionLogEntry {
	if convID == "" {
		return entry
	}
	executionTraceMu.Lock()
	defer executionTraceMu.Unlock()
	trace := executionTraces[convID]
	if trace == nil {
		trace = &executionTrace{}
		executionTraces[convID] = trace
	}
	if trace.MessageID != "" && entry.MessageID == "" {
		entry.MessageID = trace.MessageID
	}
	trace.Logs = append(trace.Logs, entry)
	return entry
}

func bindExecutionTraceMessage(convID, messageID string) []ExecutionLogEntry {
	if convID == "" || messageID == "" {
		return snapshotExecutionTrace(convID)
	}
	executionTraceMu.Lock()
	defer executionTraceMu.Unlock()
	trace := executionTraces[convID]
	if trace == nil {
		trace = &executionTrace{}
		executionTraces[convID] = trace
	}
	trace.MessageID = messageID
	logs := make([]ExecutionLogEntry, len(trace.Logs))
	for i, log := range trace.Logs {
		log.MessageID = messageID
		trace.Logs[i] = log
		logs[i] = log
	}
	return logs
}

func snapshotExecutionTrace(convID string) []ExecutionLogEntry {
	if convID == "" {
		return nil
	}
	executionTraceMu.Lock()
	defer executionTraceMu.Unlock()
	trace := executionTraces[convID]
	if trace == nil || len(trace.Logs) == 0 {
		return nil
	}
	logs := make([]ExecutionLogEntry, len(trace.Logs))
	copy(logs, trace.Logs)
	return logs
}

func finishExecutionTrace(convID string) []ExecutionLogEntry {
	if convID == "" {
		return nil
	}
	executionTraceMu.Lock()
	defer executionTraceMu.Unlock()
	trace := executionTraces[convID]
	if trace == nil {
		return nil
	}
	logs := make([]ExecutionLogEntry, len(trace.Logs))
	copy(logs, trace.Logs)
	// Do NOT delete, so subsequent logic (like persistMessageExt or summarizing) can still read them.
	// Memory is small, we can afford to keep them until reset or manual cleanup.
	return logs
}

func clearExecutionTrace(convID string) {
	if convID == "" {
		return
	}
	executionTraceMu.Lock()
	defer executionTraceMu.Unlock()
	delete(executionTraces, convID)
}
