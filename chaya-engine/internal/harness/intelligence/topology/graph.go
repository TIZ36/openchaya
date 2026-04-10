package topology

import (
	"encoding/json"
	"sync"
	"time"
)

// NodeType classifies nodes in the association layer.
type NodeType string

const (
	NodeIntent   NodeType = "intent"
	NodeSkill    NodeType = "skill"
	NodeMCP      NodeType = "mcp"
	NodeSubAgent NodeType = "sub_agent"
)

// Node is a vertex in the association layer.
type Node struct {
	ID       string   `json:"id"`
	Type     NodeType `json:"type"`
	Label    string   `json:"label"`
	Keywords []string `json:"keywords"`
	Meta     map[string]any `json:"meta,omitempty"`
}

// Edge is a weighted directed edge in the association layer.
type Edge struct {
	From      string    `json:"from"`
	To        string    `json:"to"`
	Relation  string    `json:"relation"` // uses / requires / produces
	Success   int       `json:"success"`
	Total     int       `json:"total"`
	Weight    float64   `json:"weight"` // = success/total (Bayesian)
	LastHit   time.Time `json:"last_hit"`
	DecayedAt time.Time `json:"decayed_at,omitempty"`
}

// ExecutionPath is an ordered sequence of steps in the execution layer.
type ExecutionPath struct {
	ID          string    `json:"id"`
	IntentID    string    `json:"intent_id"`
	Steps       []ExecStep `json:"steps"`
	AvgTime     int64     `json:"avg_time_ms"`
	SuccessRate float64   `json:"success_rate"`
	UseCount    int       `json:"use_count"`
}

// ExecStep is a single step in an execution path.
type ExecStep struct {
	Order     int    `json:"order"`
	Action    string `json:"action"`     // call_skill / call_mcp / delegate_sub / llm_generate
	TargetID  string `json:"target_id"`
	Parallel  []int  `json:"parallel,omitempty"` // orders that can run in parallel
	Condition string `json:"condition,omitempty"`
	Fallback  string `json:"fallback,omitempty"`
}

// Graph is the complete knowledge topology (association + execution layers).
type Graph struct {
	Nodes map[string]*Node           `json:"nodes"`
	Edges []*Edge                    `json:"edges"`
	Paths map[string]*ExecutionPath  `json:"paths"` // pathID → path
	mu    sync.RWMutex
}

func NewGraph() *Graph {
	return &Graph{
		Nodes: make(map[string]*Node),
		Paths: make(map[string]*ExecutionPath),
	}
}

// AddNode adds or updates a node.
func (g *Graph) AddNode(n *Node) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.Nodes[n.ID] = n
}

// AddEdge adds or updates an edge. If exists, updates weight.
func (g *Graph) AddEdge(e *Edge) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, existing := range g.Edges {
		if existing.From == e.From && existing.To == e.To {
			existing.Success += e.Success
			existing.Total += e.Total
			if existing.Total > 0 {
				existing.Weight = float64(existing.Success) / float64(existing.Total)
			}
			existing.LastHit = time.Now()
			return
		}
	}
	if e.Total > 0 {
		e.Weight = float64(e.Success) / float64(e.Total)
	}
	e.LastHit = time.Now()
	g.Edges = append(g.Edges, e)
}

// AddPath adds an execution path.
func (g *Graph) AddPath(p *ExecutionPath) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.Paths[p.ID] = p
}

// FindIntentNodes returns all intent nodes.
func (g *Graph) FindIntentNodes() []*Node {
	g.mu.RLock()
	defer g.mu.RUnlock()
	var nodes []*Node
	for _, n := range g.Nodes {
		if n.Type == NodeIntent {
			nodes = append(nodes, n)
		}
	}
	return nodes
}

// PathsForIntent returns all execution paths linked to an intent.
func (g *Graph) PathsForIntent(intentID string) []*ExecutionPath {
	g.mu.RLock()
	defer g.mu.RUnlock()
	var paths []*ExecutionPath
	for _, p := range g.Paths {
		if p.IntentID == intentID {
			paths = append(paths, p)
		}
	}
	return paths
}

// ApplyTimeDecay reduces weight of edges not hit within threshold.
func (g *Graph) ApplyTimeDecay(threshold time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	for _, e := range g.Edges {
		if now.Sub(e.LastHit) > threshold {
			e.Weight *= 0.5
			e.DecayedAt = now
		}
	}
}

// ToJSON serializes the graph.
func (g *Graph) ToJSON() json.RawMessage {
	g.mu.RLock()
	defer g.mu.RUnlock()
	data, _ := json.Marshal(g)
	return data
}

// FromJSON deserializes a graph.
func FromJSON(data json.RawMessage) *Graph {
	g := NewGraph()
	if len(data) == 0 || string(data) == "null" {
		return g
	}
	_ = json.Unmarshal(data, g)
	if g.Nodes == nil {
		g.Nodes = make(map[string]*Node)
	}
	if g.Paths == nil {
		g.Paths = make(map[string]*ExecutionPath)
	}
	if g.Edges == nil {
		g.Edges = []*Edge{}
	}
	return g
}

// GetNode returns a node by id (thread-safe).
func (g *Graph) GetNode(id string) *Node {
	if g == nil || id == "" {
		return nil
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.Nodes[id]
}
