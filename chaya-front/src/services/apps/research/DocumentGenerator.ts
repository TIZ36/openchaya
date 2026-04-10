/**
 * DocumentGenerator - 文档生成器
 * 生成研究报告文档
 */

import { createLogger } from '../../core/shared/utils';

const logger = createLogger('DocumentGenerator');

/**
 * 文档格式
 */
export type DocumentFormat = 'markdown' | 'html' | 'json';

/**
 * 文档章节
 */
export interface DocumentSection {
  id: string;
  title: string;
  content: string;
  level: number;
  subsections?: DocumentSection[];
}

/**
 * 文档定义
 */
export interface Document {
  title: string;
  subtitle?: string;
  author?: string;
  date: string;
  abstract?: string;
  sections: DocumentSection[];
  references?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * 文档生成器
 */
export class DocumentGenerator {
  /**
   * 生成 Markdown 文档
   */
  generateMarkdown(doc: Document): string {
    const lines: string[] = [];

    // 标题
    lines.push(`# ${doc.title}`);
    if (doc.subtitle) {
      lines.push(`## ${doc.subtitle}`);
    }
    lines.push('');

    // 元数据
    if (doc.author || doc.date) {
      lines.push('---');
      if (doc.author) lines.push(`作者: ${doc.author}`);
      lines.push(`日期: ${doc.date}`);
      lines.push('---');
      lines.push('');
    }

    // 摘要
    if (doc.abstract) {
      lines.push('## 摘要');
      lines.push(doc.abstract);
      lines.push('');
    }

    // 目录
    lines.push('## 目录');
    lines.push(this.generateTOC(doc.sections));
    lines.push('');

    // 章节
    for (const section of doc.sections) {
      lines.push(this.renderSection(section));
    }

    // 参考文献
    if (doc.references && doc.references.length > 0) {
      lines.push('## 参考文献');
      doc.references.forEach((ref, index) => {
        lines.push(`${index + 1}. ${ref}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 生成 HTML 文档
   */
  generateHTML(doc: Document): string {
    const markdown = this.generateMarkdown(doc);
    // 简单的 Markdown 到 HTML 转换
    return this.markdownToHTML(markdown);
  }

  /**
   * 生成 JSON 文档
   */
  generateJSON(doc: Document): string {
    return JSON.stringify(doc, null, 2);
  }

  /**
   * 生成文档
   */
  generate(doc: Document, format: DocumentFormat = 'markdown'): string {
    switch (format) {
      case 'markdown':
        return this.generateMarkdown(doc);
      case 'html':
        return this.generateHTML(doc);
      case 'json':
        return this.generateJSON(doc);
      default:
        return this.generateMarkdown(doc);
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 生成目录
   */
  private generateTOC(sections: DocumentSection[], indent: number = 0): string {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);

    for (const section of sections) {
      lines.push(`${prefix}- [${section.title}](#${this.slugify(section.title)})`);
      if (section.subsections) {
        lines.push(this.generateTOC(section.subsections, indent + 1));
      }
    }

    return lines.join('\n');
  }

  /**
   * 渲染章节
   */
  private renderSection(section: DocumentSection): string {
    const lines: string[] = [];
    const heading = '#'.repeat(section.level + 1);

    lines.push(`${heading} ${section.title}`);
    lines.push('');
    lines.push(section.content);
    lines.push('');

    if (section.subsections) {
      for (const sub of section.subsections) {
        lines.push(this.renderSection(sub));
      }
    }

    return lines.join('\n');
  }

  /**
   * 生成 slug
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * 简单的 Markdown 到 HTML 转换
   */
  private markdownToHTML(markdown: string): string {
    let html = markdown;

    // 标题
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // 粗体和斜体
    html = html.replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>');
    html = html.replace(/\*(.*)\*/gim, '<em>$1</em>');

    // 链接
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2">$1</a>');

    // 代码块
    html = html.replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>');
    html = html.replace(/`([^`]+)`/gim, '<code>$1</code>');

    // 列表
    html = html.replace(/^\s*- (.*$)/gim, '<li>$1</li>');

    // 段落
    html = html.replace(/\n\n/gim, '</p><p>');
    html = `<p>${html}</p>`;

    // 换行
    html = html.replace(/\n/gim, '<br>');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    pre { background: #f5f5f5; padding: 10px; overflow-x: auto; }
    code { background: #f5f5f5; padding: 2px 4px; }
  </style>
</head>
<body>
${html}
</body>
</html>`;
  }
}
