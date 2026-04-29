/**
 * Parsers for the structured `.spec/` files.
 *
 * Topic convention
 * ----------------
 * Topics are `## Topic: <name>` headers. They appear in all three spec files
 * and represent a subproject / feature area within the project. Content
 * before the first topic header is "project-wide". The dashboard groups
 * questions, tasks, and requirements sections by topic name.
 *
 * Structural headers in requirements.md (`## Goal`, `## Non-goals`, `## Users`,
 * `## Constraints`, `## Decisions`) are NOT topics — they're the project-wide
 * overview. The parser distinguishes by the explicit `Topic:` prefix.
 *
 * Markdown libraries are overkill — these formats are constrained enough
 * that line-by-line regex is more reliable and zero-dep.
 */

const TOPIC_PREFIX = /^Topic:\s*/i;

/** Strip `Topic: ` prefix from a section name; otherwise return as-is. */
function stripTopicPrefix(section: string): string {
  return section.replace(TOPIC_PREFIX, "");
}

/** True if the section name has the `Topic: ` prefix (case-insensitive). */
function isTopicSection(section: string): boolean {
  return TOPIC_PREFIX.test(section);
}

// ---------- tasks ----------

export type SpecTask = {
  id: string;
  /** 1-indexed source line number, useful if we ever wire "edit in editor". */
  line: number;
  text: string;
  done: boolean;
  /**
   * Topic name (with `Topic: ` prefix already stripped) if the task is under
   * a `## Topic: <name>` heading; null for project-wide tasks.
   */
  topic: string | null;
};

export type SpecTaskGroup = {
  /** Null for the project-wide group (tasks before any `## Topic:` header). */
  topic: string | null;
  tasks: SpecTask[];
};

export function parseTasks(content: string): SpecTask[] {
  if (!content) return [];
  const out: SpecTask[] = [];
  const lines = content.split(/\r?\n/);
  const checkbox = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
  const heading = /^\s*##\s+(.*\S)\s*$/;
  // A bullet on a continuation line starts a NEW task, so detect those
  // even when they're indented (nested bullets without checkboxes still
  // belong to the parent task as continuation prose).
  const newCheckbox = /^\s*[-*+]\s+\[[ xX]\]\s+/;
  const newHeading = /^\s*##\s+\S/;
  let currentTopic: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const h = heading.exec(line);
    if (h) {
      const sectionName = h[1] ?? "";
      currentTopic = isTopicSection(sectionName)
        ? stripTopicPrefix(sectionName).trim()
        : null;
      i += 1;
      continue;
    }
    const m = checkbox.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const done = m[1] !== " ";
    const headText = (m[2] ?? "").trim();
    // Greedy: consume any following lines that are indented continuation
    // (or wrapped prose under the bullet). We stop at the next blank
    // line, the next bullet (checked or unchecked nested), or the next
    // heading. Most spec writers wrap long bullets across multiple
    // indented lines; without this, only the first line surfaces.
    const startLine = i;
    const collected: string[] = [headText];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (next.trim().length === 0) break;
      if (newHeading.test(next)) break;
      if (newCheckbox.test(next)) break;
      // Anything else under the bullet is continuation. Trim leading
      // indentation so the joined text reads naturally.
      collected.push(next.trim());
      j += 1;
    }
    const text = collected.filter((s) => s.length > 0).join("\n");
    if (text.length > 0) {
      out.push({
        id: `t${startLine}-${hashShort(text)}`,
        line: startLine + 1,
        text,
        done,
        topic: currentTopic,
      });
    }
    i = j;
  }
  return out;
}

export function groupTasksByTopic(tasks: SpecTask[]): SpecTaskGroup[] {
  const groups: SpecTaskGroup[] = [];
  for (const t of tasks) {
    const last = groups[groups.length - 1];
    if (last && last.topic === t.topic) {
      last.tasks.push(t);
    } else {
      groups.push({ topic: t.topic, tasks: [t] });
    }
  }
  return groups;
}

// ---------- questions ----------

export type SpecQuestion = {
  id: string;
  number: number;
  text: string;
  /**
   * Topic name (with `Topic: ` prefix already stripped) if the question is
   * under a `## Topic: <name>` heading; null for project-wide questions.
   */
  topic: string | null;
  /**
   * Raw section name as it appeared (without the `Topic: ` prefix stripped).
   * Used by the wizard panel which shows ALL `##` groups, not just topics.
   */
  section: string | null;
};

export type SpecQuestionGroup = {
  /** Section name as it appeared (with prefix). Null for the project-wide group. */
  section: string | null;
  questions: SpecQuestion[];
};

export function parseQuestions(content: string): SpecQuestion[] {
  if (!content) return [];
  const out: SpecQuestion[] = [];
  const lines = content.split(/\r?\n/);
  const numbered = /^\s*(\d+)[.)]\s+(.*\S)\s*$/;
  const heading = /^\s*##\s+(.*\S)\s*$/;
  let currentSection: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const h = heading.exec(line);
    if (h) {
      currentSection = h[1] ?? null;
      continue;
    }
    const m = numbered.exec(line);
    if (!m) continue;
    const number = Number.parseInt(m[1] ?? "0", 10);
    const text = m[2] ?? "";
    if (text.length === 0) continue;
    const topic =
      currentSection && isTopicSection(currentSection)
        ? stripTopicPrefix(currentSection).trim()
        : null;
    out.push({
      id: `q${i}-${hashShort(text)}`,
      number,
      text,
      topic,
      section: currentSection,
    });
  }
  return out;
}

/** Group questions by section header, preserving source order. */
export function groupQuestions(questions: SpecQuestion[]): SpecQuestionGroup[] {
  const groups: SpecQuestionGroup[] = [];
  for (const q of questions) {
    const last = groups[groups.length - 1];
    if (last && last.section === q.section) {
      last.questions.push(q);
    } else {
      groups.push({ section: q.section, questions: [q] });
    }
  }
  return groups;
}

/** Group questions by topic (project-wide = null). Drops the section nuance. */
export type SpecQuestionTopicGroup = {
  topic: string | null;
  questions: SpecQuestion[];
};

export function groupQuestionsByTopic(
  questions: SpecQuestion[],
): SpecQuestionTopicGroup[] {
  const byTopic = new Map<string | null, SpecQuestion[]>();
  for (const q of questions) {
    const arr = byTopic.get(q.topic) ?? [];
    arr.push(q);
    byTopic.set(q.topic, arr);
  }
  const out: SpecQuestionTopicGroup[] = [];
  // Preserve insertion order: null group first if present, then topic groups
  // in the order they first appeared in the source.
  if (byTopic.has(null)) {
    out.push({ topic: null, questions: byTopic.get(null) ?? [] });
  }
  for (const [topic, qs] of byTopic) {
    if (topic === null) continue;
    out.push({ topic, questions: qs });
  }
  return out;
}

// ---------- requirements ----------

/**
 * A `## Topic: <name>` section parsed from requirements.md, with the
 * heading line removed and the body trimmed.
 */
export type RequirementsTopic = {
  /** Topic name without the `Topic: ` prefix. */
  name: string;
  /** The body markdown for this topic, NOT including the heading line. */
  markdown: string;
};

export type RequirementsParse = {
  /** Markdown content before the first `## Topic:` heading — the project-wide overview. */
  overview: string;
  /** One entry per `## Topic: <name>` section, in source order. */
  topics: RequirementsTopic[];
};

/**
 * Split requirements.md into a project-wide overview plus a list of topic
 * sections. Non-topic `##` headers (Goal, Users, Constraints, etc.) live
 * inside the overview block — we don't try to interpret them; the dashboard
 * renders the whole overview as markdown.
 */
export function parseRequirements(content: string): RequirementsParse {
  if (!content) return { overview: "", topics: [] };
  const lines = content.split(/\r?\n/);
  const heading = /^\s*##\s+(.*\S)\s*$/;
  const overviewLines: string[] = [];
  const topics: RequirementsTopic[] = [];
  let current: RequirementsTopic | null = null;
  let inOverview = true;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const h = heading.exec(line);
    if (h && isTopicSection(h[1] ?? "")) {
      // Close any in-progress topic and start a new one.
      if (current) {
        current.markdown = current.markdown.replace(/\s+$/, "");
        topics.push(current);
      }
      current = {
        name: stripTopicPrefix(h[1] ?? "").trim(),
        markdown: "",
      };
      inOverview = false;
      continue;
    }
    if (inOverview) {
      overviewLines.push(line);
    } else if (current) {
      current.markdown += line + "\n";
    }
  }
  if (current) {
    current.markdown = current.markdown.replace(/\s+$/, "");
    topics.push(current);
  }
  return {
    overview: overviewLines.join("\n").replace(/\s+$/, ""),
    topics,
  };
}

/**
 * Truncate a markdown string to the first N characters or to the end of its
 * first paragraph (whichever is shorter), with an ellipsis if truncated.
 * Used by the dashboard for topic-card previews.
 */
export function previewMarkdown(md: string, maxChars = 280): string {
  const trimmed = md.trim();
  if (trimmed.length === 0) return "";
  // First paragraph = up to a blank line.
  const firstPara = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  const candidate =
    firstPara.length <= maxChars
      ? firstPara
      : firstPara.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
  return candidate;
}

// ---------- helpers ----------

/** djb2-ish 32-bit hash → base36, plenty for stable React keys. */
function hashShort(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
