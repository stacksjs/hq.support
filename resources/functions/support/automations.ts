import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

type Node = { id: string, type: string, next?: string, [key: string]: unknown }
type Definition = { start: string, nodes: Node[] }
interface Workflow { id: string | number, name: string, event: string, definition: string, enabled: boolean, published_version: number }
interface Run { id: number, workflow_id: number, status: string, step_count: number, attempts: number, last_error: string, created_at: string }
const initial = (): Definition => ({ start: 'received', nodes: [{ id: 'received', type: 'note', body: 'New conversation received.', next: 'done' }, { id: 'done', type: 'end' }] })
export function createAutomations() {
  const workspace = createSupportConsole()
  const workflows = state<Workflow[]>([])
  const selected = state<Workflow | null>(null)
  const name = state('')
  const event = state('conversation.created')
  const start = state('received')
  const nodes = state<Node[]>([])
  const editorOpen = state(false)
  const baseline = state('')
  const executionAvailable = state(false)
  const agents = state<{ id: string, name: string, email: string, role: string }[]>([])
  const runs = state<Run[]>([])
  const runDetail = state<{ run: Run, steps: { step_id: string, type: string, result: string, created_at: string }[] } | null>(null)
  const nodeId = state('')
  const nodeType = state('note')
  const next = state('')
  const text = state('')
  const seconds = state('60')
  const assignee = state('')
  const tag = state('')
  const nodeTitle = state('')
  const status = state('open')
  const conditionField = state('contact.attributes.plan')
  const operator = state('eq')
  const comparison = state('')
  const yes = state('')
  const no = state('')
  const tool = state('contact.set_attribute')
  const attributeKey = state('')
  const attributeValue = state('')
  const json = state('')
  const nodeBaseline = state('')
  const nodeSnapshot = () => JSON.stringify([nodeType(), next(), text(), seconds(), assignee(), tag(), nodeTitle(), status(), conditionField(), operator(), comparison(), yes(), no(), tool(), attributeKey(), attributeValue()])
  const nodeDirty = derived(() => !!nodeId() && nodeSnapshot() !== nodeBaseline())
  const definition = () => ({ start: start(), nodes: nodes() })
  const snapshot = () => JSON.stringify({ name: name(), event: event(), definition: definition() })
  const dirty = derived(() => editorOpen() && snapshot() !== baseline())
  const nodeTypes = ['condition', 'wait', 'assign', 'tag', 'reply', 'note', 'ticket', 'status', 'tool', 'start_conversation', 'end']
  async function load() {
    if (!workspace.project() || dirty()) return
    const selectedProject = workspace.project()
    const result = await workspace.run(async () => {
      const workflows = await workspace.request(workspace.projectPath('/automations'))
      if (!workspace.canManage()) return { ...workflows, runs: [], agents: [] }
      const [history, roster] = await Promise.all([workspace.request(workspace.projectPath('/automation-runs')), workspace.request(workspace.projectPath('/agents'))])
      return { ...workflows, runs: history.runs || [], agents: roster.agents || [] }
    })
    if (!result || selectedProject !== workspace.project()) return
    workflows.set(result.workflows || [])
    executionAvailable.set(result.executionAvailable === true)
    runs.set(result.runs)
    agents.set(result.agents)
  }
  async function boot() { await workspace.boot(); await load() }
  function selectNode(node: Node) {
    nodeId.set(node.id); nodeType.set(node.type); next.set(String(node.next || ''))
    text.set(String(node.body || node.description || '')); seconds.set(String(node.seconds || 60)); assignee.set(String(node.userId || ''))
    tag.set(String(node.tag || '')); nodeTitle.set(String(node.title || node.subject || '')); status.set(String(node.status || 'open'))
    conditionField.set(String(node.field || 'contact.attributes.plan')); operator.set(String(node.operator || 'eq')); comparison.set(JSON.stringify(node.value ?? ''))
    yes.set(String(node.yes || '')); no.set(String(node.no || '')); tool.set(String(node.tool || 'contact.set_attribute')); attributeKey.set(String(node.key || '')); attributeValue.set(JSON.stringify(node.value ?? ''))
    nodeBaseline.set(nodeSnapshot())
  }
  function select(item: Workflow | null) {
    selected.set(item); name.set(item?.name || ''); event.set(item?.event || 'conversation.created')
    let data = initial()
    try { if (item) data = JSON.parse(item.definition) }
    catch { workspace.error.set('This workflow definition could not be read. Reload before saving.') }
    nodes.set(data.nodes); start.set(data.start); editorOpen.set(true); json.set(JSON.stringify(data, null, 2)); baseline.set(snapshot()); workspace.notice.set(''); runDetail.set(null)
    if (data.nodes[0]) selectNode(data.nodes[0])
  }
  function addNode() {
    if (nodes().length >= 50) { workspace.error.set('A workflow supports at most 50 steps.'); return }
    let index = nodes().length + 1
    while (nodes().some(node => node.id === `step_${index}`)) index++
    const node = { id: `step_${index}`, type: 'end' }
    nodes.update(items => [...items, node]); selectNode(node); json.set(JSON.stringify(definition(), null, 2))
  }
  function removeNode() {
    if (nodes().length <= 1 || nodeId() === start()) { workspace.error.set('Keep at least one step. Change the start step before removing it.'); return }
    const id = nodeId()
    if (nodes().some(node => node.next === id || node.yes === id || node.no === id)) { workspace.error.set('Change transitions that point to this step before removing it.'); return }
    nodes.update(items => items.filter(node => node.id !== id)); selectNode(nodes()[0]!); json.set(JSON.stringify(definition(), null, 2))
  }
  function applyNode() {
    workspace.error.set('')
    try {
      const type = nodeType(), node: Node = { id: nodeId(), type, ...(next() && type !== 'condition' && type !== 'end' ? { next: next() } : {}) }
      if (type === 'reply' || type === 'note' || type === 'start_conversation') node.body = text()
      if (type === 'wait') node.seconds = Number(seconds())
      if (type === 'assign') node.userId = Number(assignee())
      if (type === 'tag') node.tag = tag()
      if (type === 'status') node.status = status()
      if (type === 'ticket') { node.title = nodeTitle(); node.description = text() }
      if (type === 'start_conversation') node.subject = nodeTitle()
      if (type === 'condition') { node.field = conditionField(); node.operator = operator(); node.value = comparison().trim() ? JSON.parse(comparison()) : ''; node.yes = yes(); node.no = no() }
      if (type === 'tool') { node.tool = tool(); node.key = attributeKey(); node.value = attributeValue().trim() ? JSON.parse(attributeValue()) : '' }
      nodes.update(items => items.map(item => item.id === nodeId() ? node : item)); nodeBaseline.set(nodeSnapshot()); json.set(JSON.stringify(definition(), null, 2)); workspace.notice.set('Step changes applied to your draft. Save the workflow to persist them.')
    }
    catch { workspace.error.set('Comparison and attribute values must be valid JSON, for example "starter", 10, or true.') }
  }
  function discardNode() { const node = nodes().find(item => item.id === nodeId()); if (node) selectNode(node) }
  function applyJson() {
    try {
      const value = JSON.parse(json())
      if (!value || !Array.isArray(value.nodes) || !value.nodes.length || typeof value.start !== 'string' || value.nodes.some((node: Node) => !node.id || !nodeTypes.includes(node.type))) throw new Error('Invalid graph')
      nodes.set(value.nodes); start.set(value.start); selectNode(value.nodes[0]); workspace.error.set(''); workspace.notice.set('Definition applied to your draft. The server validates all transitions when you save.')
    }
    catch { workspace.error.set('Use a definition with a start step and a nonempty nodes array of supported steps.') }
  }
  async function save() {
    if (!workspace.canManage() || workspace.pending()) return
    const item = selected()
    const result = await workspace.run(() => workspace.request(workspace.projectPath(item ? `/automations/${item.id}/draft` : '/automations'), { method: 'POST', body: snapshot() }), workspace.pending)
    if (!result?.workflow) return
    workflows.update(items => [result.workflow, ...items.filter(row => String(row.id) !== String(result.workflow.id))]); select(result.workflow); workspace.notice.set('Draft saved. Publish it when it is ready to handle new events.')
  }
  async function publish() {
    if (!selected() || dirty() || !executionAvailable() || workspace.pending()) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/automations/${selected()!.id}/publish`), { method: 'POST', body: '{}' }), workspace.pending)
    if (!result?.workflow) return
    workflows.update(items => items.map(row => String(row.id) === String(result.workflow.id) ? result.workflow : row)); select(result.workflow); workspace.notice.set(`Version ${result.version} published. Future matching events use this saved version.`)
  }
  async function pause() {
    if (!selected() || workspace.pending()) return
    const item = selected()!
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/automations/${item.id}/pause`), { method: 'POST', body: '{}' }), workspace.pending)
    if (!result) return
    const updated = { ...item, enabled: false }; workflows.update(items => items.map(row => String(row.id) === String(item.id) ? updated : row)); selected.set(updated); workspace.notice.set('Workflow paused. Already recorded runs remain visible in history.')
  }
  async function viewRun(run: Run) {
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/automation-runs/${run.id}`)), workspace.pending)
    if (result) runDetail.set(result)
  }
  async function changeProject() { selected.set(null); editorOpen.set(false); nodes.set([]); runs.set([]); runDetail.set(null); baseline.set(''); await load() }
  function discard() { if (selected()) select(selected()); else editorOpen.set(false) }
  return { workspace, agents, nodeDirty, discardNode, workflows, selected, name, event, start, nodes, nodeId, nodeType, next, text, seconds, assignee, tag, nodeTitle, status, conditionField, operator, comparison, yes, no, tool, attributeKey, attributeValue, nodeTypes, json, editorOpen, executionAvailable, dirty, runs, runDetail, load, boot, select, selectNode, addNode, removeNode, applyNode, applyJson, save, publish, pause, viewRun, changeProject, discard }
}
