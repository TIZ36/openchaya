package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/memory"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/rag"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/skill"
	"github.com/chaya-ai/chaya-engine/internal/harness/intelligence/topology"
	pkg "github.com/chaya-ai/chaya-engine/pkg"
	"gorm.io/gorm"
)

// EnrichedContext holds all the context gathered by the orchestrator
// to be injected into the LLM system prompt.
type EnrichedContext struct {
	MCPTools     []pkg.Tool         // all available MCP tools (for function calling)
	Memory       string             // formatted memory string
	KBContext    string             // RAG retrieval from pgvector (agent-scoped KB)
	SkillCatalog []skill.IndexEntry // always-loaded skill directory
	ActiveSkills []skill.Skill      // matched skills with full SOP
	TopologyHint string             // behavior topology hit (when topologyEnabled)
	TopologyMatch *topology.Match `json:"-"` // last Consult hit (trace / sync; not for API echo)
}

// Orchestrator coordinates all capabilities to build enriched context.
type Orchestrator struct {
	MCPRegistry   *mcp.Registry
	MemoryStore   *memory.Store
	SkillRegistry *skill.Registry
	DB            *gorm.DB // agent_topology + skills
	Retriever     *rag.Retriever
	harness       HarnessRuntimeConfig
}

type ProgressSink func(string)

// NewOrchestrator creates the harness orchestrator. Pass nil harnessCfg for defaults.
func NewOrchestrator(mcpReg *mcp.Registry, memStore *memory.Store, skillReg *skill.Registry, db *gorm.DB, retriever *rag.Retriever, harnessCfg *HarnessRuntimeConfig) *Orchestrator {
	h := DefaultHarnessRuntimeConfig()
	if harnessCfg != nil {
		h = mergeHarnessRuntimeConfig(h, *harnessCfg)
	}
	return &Orchestrator{
		MCPRegistry:   mcpReg,
		MemoryStore:   memStore,
		SkillRegistry: skillReg,
		DB:            db,
		Retriever:     retriever,
		harness:       h,
	}
}

// HarnessMetricsVerbose reports whether harness should emit extra debug detail.
func (o *Orchestrator) HarnessMetricsVerbose() bool {
	return o.harness.MetricsVerbose
}

func mergeHarnessRuntimeConfig(base, overlay HarnessRuntimeConfig) HarnessRuntimeConfig {
	out := base
	if overlay.PromptToolsTextEstTokens > 0 {
		out.PromptToolsTextEstTokens = overlay.PromptToolsTextEstTokens
	}
	if overlay.PromptRAGEstTokens > 0 {
		out.PromptRAGEstTokens = overlay.PromptRAGEstTokens
	}
	if overlay.PromptSkillSOPEstTokens > 0 {
		out.PromptSkillSOPEstTokens = overlay.PromptSkillSOPEstTokens
	}
	if overlay.PromptMemoryEstTokens > 0 {
		out.PromptMemoryEstTokens = overlay.PromptMemoryEstTokens
	}
	if overlay.ToolSelectMaxPerServer > 0 {
		out.ToolSelectMaxPerServer = overlay.ToolSelectMaxPerServer
	}
	if overlay.ToolSelectMinKeywordScore > 0 {
		out.ToolSelectMinKeywordScore = overlay.ToolSelectMinKeywordScore
	}
	if overlay.MetricsVerbose {
		out.MetricsVerbose = true
	}
	return out
}

// BuildContext concurrently gathers context from all capabilities.
// MCP tools are collected separately (for function calling, not prompt injection).
// When topologyEnabled is true, loads agent_topology, runs keyword Consult, merges path skills into ActiveSkills.
// MCP tools: per-tenant and per-agent harness scope (agent_mcp_servers bindings, else all enabled servers for tenant).
// When delegatedMCPServerIDs is non-nil/non-empty, tools are loaded from those IDs after tenant filter.
// Skills: tenant-scoped catalog (primary: all tenant skills; sub: agent_skills join).
// userID is required for OAuth MCP servers that use per-user tokens.
// isPrimary is retained for API compatibility; MCP/Skill visibility no longer depends on it.
func (o *Orchestrator) BuildContext(ctx context.Context, userMsg, agentID, userID, tenantID string, topologyEnabled, isPrimary bool, delegatedMCPServerIDs map[string]struct{}, progress ProgressSink) *EnrichedContext {
	_ = isPrimary // skill catalog phase still uses primary vs sub; MCP scope is agent+tenant
	ec := &EnrichedContext{}
	var wg sync.WaitGroup
	var kbText string
	var kbCount int

	// 1. MCP tools — tenant-isolated; agent bindings from agent_mcp_servers, else all enabled servers for tenant
	wg.Add(1)
	go func() {
		defer wg.Done()
		if o.MCPRegistry == nil {
			return
		}
		reportToolProgress := func(tp mcp.ToolsProgress) {
			if progress == nil {
				return
			}
			if tp.Err != nil {
				progress(fmt.Sprintf("MCP[%s] 连接失败：%v", tp.ServerName, tp.Err))
				return
			}
			if tp.FromCache {
				progress(fmt.Sprintf("MCP[%s] 已就绪", tp.ServerName))
			} else {
				progress(fmt.Sprintf("MCP[%s] 已连接", tp.ServerName))
			}
		}
		if len(delegatedMCPServerIDs) > 0 {
			filtered := o.MCPRegistry.FilterServerIDsByTenant(delegatedMCPServerIDs, tenantID)
			ec.MCPTools = o.MCPRegistry.ListToolsForServerIDsWithProgress(ctx, filtered, 3*time.Second, reportToolProgress, userID, tenantID)
		} else {
			ec.MCPTools = o.MCPRegistry.ListToolsForHarness(ctx, agentID, 3*time.Second, reportToolProgress, userID, tenantID)
		}
	}()

	// 2. Memory (from Redis)
	wg.Add(1)
	go func() {
		defer wg.Done()
		if o.MemoryStore != nil {
			ec.Memory = o.MemoryStore.FormatForContext(ctx, agentID)
		}
	}()

	// 3. Skills (two-phase: catalog always, SOP on keyword match)
	wg.Add(1)
	go func() {
		defer wg.Done()
		if o.SkillRegistry != nil {
			ec.SkillCatalog, ec.ActiveSkills = o.SkillRegistry.Match(userMsg, agentID, tenantID, true)
		}
	}()

	// 4. Knowledge base (RAG): embed query + pgvector similarity
	wg.Add(1)
	go func() {
		defer wg.Done()
		if o.Retriever == nil || agentID == "" {
			return
		}
		results := o.Retriever.Retrieve(ctx, userMsg, agentID, tenantID, 5)
		kbText = rag.FormatForPromptBudget(results, o.harness.PromptRAGEstTokens)
		kbCount = len(results)
	}()

	wg.Wait()
	ec.KBContext = kbText

	// 5. Behavior topology (optional)
	if topologyEnabled && o.DB != nil && o.SkillRegistry != nil {
		g := o.loadTopologyGraph(agentID)
		if g != nil {
			if m := topology.Consult(g, userMsg); m != nil {
				ec.TopologyMatch = m
				toolHints := topologyToolHints(ec.MCPTools)
				skillHints := topologySkillHints(ec)
				ec.TopologyHint = topology.FormatMatchForPromptEnriched(m, toolHints, skillHints)
				o.mergeSkillsFromTopologyPath(m, tenantID, ec)
			}
		}
	}

	// Consolidated summary — one line replacing 10+ individual messages
	if progress != nil {
		var parts []string
		parts = append(parts, fmt.Sprintf("%d 个工具", len(ec.MCPTools)))
		if kbCount > 0 {
			parts = append(parts, fmt.Sprintf("知识库 %d 条", kbCount))
		}
		if ec.Memory != "" {
			parts = append(parts, "记忆已加载")
		}
		if len(ec.ActiveSkills) > 0 {
			parts = append(parts, fmt.Sprintf("技能 %d 个", len(ec.ActiveSkills)))
		}
		if ec.TopologyHint != "" {
			parts = append(parts, "命中行为拓扑")
		}
		progress(fmt.Sprintf("上下文就绪：%s", strings.Join(parts, " · ")))
	}

	return ec
}

func (o *Orchestrator) loadTopologyGraph(agentID string) *topology.Graph {
	type row struct {
		Graph json.RawMessage `gorm:"column:graph"`
	}
	var r row
	if err := o.DB.Table("agent_topology").Select("graph").Where("agent_id = ?", agentID).Scan(&r).Error; err != nil || len(r.Graph) == 0 {
		return nil
	}
	return topology.FromJSON(r.Graph)
}

func (o *Orchestrator) mergeSkillsFromTopologyPath(m *topology.Match, tenantID string, ec *EnrichedContext) {
	if m == nil || m.Path == nil || o.SkillRegistry == nil {
		return
	}
	seen := make(map[string]struct{})
	for _, s := range ec.ActiveSkills {
		seen[s.ID] = struct{}{}
	}
	for _, step := range m.Path.Steps {
		if step.Action != "call_skill" || step.TargetID == "" {
			continue
		}
		if _, ok := seen[step.TargetID]; ok {
			continue
		}
		sk, err := o.SkillRegistry.GetSkillByTenant(step.TargetID, tenantID)
		if err != nil || sk == nil {
			continue
		}
		ec.ActiveSkills = append(ec.ActiveSkills, *sk)
		seen[sk.ID] = struct{}{}
	}
}

func topologyToolHints(tools []pkg.Tool) map[string]string {
	out := make(map[string]string)
	for _, t := range tools {
		name := strings.TrimSpace(t.Name)
		if name == "" {
			continue
		}
		if _, ok := out[name]; ok {
			continue
		}
		d := strings.TrimSpace(t.Description)
		if len(d) > 160 {
			d = d[:160] + "…"
		}
		out[name] = d
	}
	return out
}

func topologySkillHints(ec *EnrichedContext) map[string]string {
	if ec == nil {
		return nil
	}
	out := make(map[string]string)
	for _, e := range ec.SkillCatalog {
		id := strings.TrimSpace(e.ID)
		if id == "" {
			continue
		}
		out[id] = strings.TrimSpace(e.Name)
	}
	for _, s := range ec.ActiveSkills {
		id := strings.TrimSpace(s.ID)
		if id == "" {
			continue
		}
		out[id] = strings.TrimSpace(s.Name)
	}
	return out
}
