/* ============================================================
   fbotMenu —— 录入飞书助手的「业务菜单规格」

   这是接真实业务的唯一入口。fbot.cjs 读这个 spec 生成菜单卡/表单卡，
   并在用户提交时回调 onSubmit / onAction。改业务 = 改这个文件。

   spec 结构：
     menu:    一张能力菜单（@机器人后弹出）
       title / template / intro
       options: [{ key, text, type, form?, action? }]
         - form:   点击后弹出 forms[form] 表单卡
         - action: 点击后调用 onAction(action)（自定义逻辑，可返回 {card,toast}）
     forms:   { [formKey]: { title, template, submitText, fields:[...] } }
       field: { name, kind:'input'|'multiline'|'select', label, placeholder, required, default, options:[[value,label]] }
     onSubmit(formKey, values, ctx) -> { ok, toast?, message?, title?, template?, card? }
       - 在这里落库 / 写 Bitable / 建工作项 / 调后端
       - 返回 ok:false + message 可让卡片提示校验错误
       - 返回 card 可完全自定义回执卡
     onAction(action, ctx) -> { card?, toast? }
       - 处理非表单的菜单项（如「查询状态」）

   ctx: { operator: {open_id,...}, openMessageId }
   ============================================================ */

const menu = {
  title: '录入飞书助手',
  template: 'blue',
  intro: '你好，我是 **录入助手**。请选择要做的事👇',
  options: [
    { key: 'new_callback', text: '📝 新建回传需求', type: 'primary', form: 'callback' },
    { key: 'query', text: '🔍 查询状态', type: 'default', action: 'query' },
    // 加新业务：复制一行，配 form 或 action
    // { key: 'new_bug', text: '🐞 提Bug', type: 'default', form: 'bug' },
  ],
};

const forms = {
  callback: {
    title: '新建回传需求',
    template: 'wathet',
    submitText: '提交',
    fields: [
      { name: 'title', kind: 'input', label: '需求名称', placeholder: '例如：ROK越南iOS单账户回传', required: true },
      { name: 'ticket', kind: 'input', label: '关联单号', placeholder: 'm-12345' },
      { name: 'priority', kind: 'select', label: '优先级', required: true, placeholder: '请选择', options: [
        ['P0', 'P0 紧急'], ['P1', 'P1 高'], ['P2', 'P2 普通'],
      ] },
      { name: 'detail', kind: 'multiline', label: '需求描述', placeholder: '简述背景/期望/验收点', rows: 3 },
    ],
  },
};

// ====== 业务处理：表单提交 ======
async function onSubmit(formKey, values, ctx) {
  if (formKey === 'callback') {
    // —— 基础校验（示例）——
    if (!values.title || !values.title.trim()) return { ok: false, message: '需求名称不能为空' };

    // ============================================================
    // TODO(接真实业务)：在这里把 values 落地，三选一或组合：
    //   1) 写后端：authFetch(POST /api/...) 建回传需求
    //   2) 写飞书多维表格 Bitable：client.bitable.v1.appTableRecord.create(...)
    //   3) 建飞书工作项 / 发通知给负责人
    // 提交人 open_id 在 ctx.operator.open_id。
    // 现在是骨架：只打印，回执卡照常返回。
    // ============================================================
    console.log('[fbotMenu] 新建回传需求:', JSON.stringify(values), 'by', ctx.operator && ctx.operator.open_id);

    return {
      ok: true,
      toast: '已创建',
      title: '✅ 回传需求已创建',
      template: 'green',
      message: '骨架演示：把 onSubmit 接到落库逻辑即可真正入库',
    };
  }
  return { ok: true };
}

// ====== 业务处理：非表单菜单项 ======
async function onAction(action, ctx) {
  if (action === 'query') {
    // TODO(接真实业务)：按 ctx.operator.open_id / 单号查进度，拼一张卡返回。
    return {
      toast: { type: 'info', content: '查询示例' },
      card: {
        schema: '2.0', config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '🔍 查询状态' }, template: 'turquoise' },
        body: { elements: [{ tag: 'markdown', content: '示例：这里接你的查询逻辑（按单号/人查回传需求进度）。' }] },
      },
    };
  }
  return { toast: { type: 'warning', content: '未实现' } };
}

module.exports = { menu, forms, onSubmit, onAction };
