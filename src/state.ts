/**
 * App-state types + tiny helpers shared by App.tsx.
 *
 * Persisted state (matches the Rust AppPersistedState struct field-for-field):
 *   - projects: list of folder-roots the user has registered
 *   - sessions: metadata for every chat session (NOT the message history —
 *     the SDK persists that and we resume by sdkSessionId)
 */

/**
 * Per-project permission mode for tool execution.
 *   - "ask"          Surface every tool request — currently surfaces as an
 *                    error in chat because canUseTool isn't wired yet. Will
 *                    become a real prompt when the permission UI lands.
 *   - "acceptEdits"  Auto-accept Read/Write/Edit tools; everything else (e.g.
 *                    Bash) still errors. Default for new projects.
 *   - "bypassAll"    Allow every tool without prompting. Use on projects you
 *                    fully trust the agent in.
 */
export type ProjectPermissionMode = "ask" | "acceptEdits" | "bypassAll";

export const DEFAULT_PERMISSION_MODE: ProjectPermissionMode = "acceptEdits";

/** Limited palette so colors stay legible against the zinc-950 sidebar. */
export type ProjectColor =
  | "zinc"
  | "sky"
  | "emerald"
  | "amber"
  | "rose"
  | "violet";

export const PROJECT_COLORS: readonly ProjectColor[] = [
  "zinc",
  "sky",
  "emerald",
  "amber",
  "rose",
  "violet",
];

export const DEFAULT_PROJECT_COLOR: ProjectColor = "zinc";

/**
 * Tailwind class lookups for project colors. Listed as full string literals
 * so Tailwind's content scanner picks them up at build time — dynamic
 * concatenation like `bg-${c}-500` would NOT work.
 */
export const PROJECT_COLOR_DOT_CLS: Record<ProjectColor, string> = {
  zinc: "bg-zinc-400",
  sky: "bg-sky-400",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  violet: "bg-violet-400",
};

export const PROJECT_COLOR_BORDER_CLS: Record<ProjectColor, string> = {
  zinc: "border-zinc-500",
  sky: "border-sky-500",
  emerald: "border-emerald-500",
  amber: "border-amber-500",
  rose: "border-rose-500",
  violet: "border-violet-500",
};

export type Project = {
  id: string;
  name: string;
  path: string;
  /** ISO-8601, stamped on each selection. Used as a tiebreaker for initial
   * selection on app start; sidebar order is otherwise user-controlled. */
  lastOpenedAt: string | null;
  permissionMode: ProjectPermissionMode;
  color: ProjectColor;
};

export type SessionMode = "free" | "spec";

export type Session = {
  id: string;
  projectId: string;
  /** Captured from the SDK's first system/init event; used for resume. */
  sdkSessionId: string | null;
  title: string;
  mode: SessionMode;
  startedAt: string | null;
  lastMessageAt: string | null;
};

export type AppPersistedState = {
  version: number;
  projects: Project[];
  sessions: Session[];
};

export const APP_STATE_VERSION = 1;

/**
 * Sentinel prefixes for the three project-level views. The tab strip pins
 * Product / Codebase / Tasks at the start; clicking one sets
 * `selectedSessionId` to the corresponding sentinel. Lookups against the
 * sessions list miss for these ids — the main area renders the matching
 * project view instead of a chat.
 */
export const PRODUCT_VIEW_PREFIX = "product-view:";
export const CODEBASE_VIEW_PREFIX = "codebase-view:";
export const TASKS_VIEW_PREFIX = "tasks-view:";
export const TASK_VIEW_PREFIX = "task-view:";
export const DIFF_VIEW_PREFIX = "diff-view:";

export function productViewIdForProject(projectId: string): string {
  return PRODUCT_VIEW_PREFIX + projectId;
}
export function codebaseViewIdForProject(projectId: string): string {
  return CODEBASE_VIEW_PREFIX + projectId;
}
export function tasksViewIdForProject(projectId: string): string {
  return TASKS_VIEW_PREFIX + projectId;
}
/**
 * Sentinel id for the per-task detail view. Encoded as
 * `task-view:<projectId>:<taskId>` so the parser can reach both pieces
 * back out without extra plumbing.
 */
export function taskViewIdForProject(projectId: string, taskId: string): string {
  return `${TASK_VIEW_PREFIX}${projectId}:${taskId}`;
}
export function diffViewIdForProject(projectId: string): string {
  return DIFF_VIEW_PREFIX + projectId;
}

export function isProductViewId(id: string | null): boolean {
  return typeof id === "string" && id.startsWith(PRODUCT_VIEW_PREFIX);
}
export function isCodebaseViewId(id: string | null): boolean {
  return typeof id === "string" && id.startsWith(CODEBASE_VIEW_PREFIX);
}
export function isTasksViewId(id: string | null): boolean {
  return typeof id === "string" && id.startsWith(TASKS_VIEW_PREFIX);
}
export function isTaskViewId(id: string | null): boolean {
  return typeof id === "string" && id.startsWith(TASK_VIEW_PREFIX);
}
export function isDiffViewId(id: string | null): boolean {
  return typeof id === "string" && id.startsWith(DIFF_VIEW_PREFIX);
}

/**
 * Pull `(projectId, taskId)` out of a task-view sentinel. Returns null
 * when the id isn't a task-view id, doesn't have both segments, or is
 * malformed.
 */
export function parseTaskViewId(
  id: string | null,
): { projectId: string; taskId: string } | null {
  if (!isTaskViewId(id) || typeof id !== "string") return null;
  const rest = id.slice(TASK_VIEW_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { projectId: rest.slice(0, sep), taskId: rest.slice(sep + 1) };
}

/**
 * True for any project-level view (Product, Codebase, Tasks, single
 * task detail, or Diff). Diff and task views are included so chat-only
 * logic (composer, busy state) skips them.
 */
export function isProjectViewId(id: string | null): boolean {
  return (
    isProductViewId(id) ||
    isCodebaseViewId(id) ||
    isTasksViewId(id) ||
    isTaskViewId(id) ||
    isDiffViewId(id)
  );
}

/** Stable ids for objects we mint client-side. */
export function newId(): string {
  // crypto.randomUUID is available in modern browsers and the Tauri WebView.
  // Fall back to a time-based id just in case the runtime is unusually old.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Cycle the permission mode in a fixed order for a one-click chip. */
export function nextPermissionMode(
  m: ProjectPermissionMode,
): ProjectPermissionMode {
  switch (m) {
    case "ask":
      return "acceptEdits";
    case "acceptEdits":
      return "bypassAll";
    case "bypassAll":
      return "ask";
  }
}

export function permissionModeLabel(m: ProjectPermissionMode): string {
  switch (m) {
    case "ask":
      return "Ask";
    case "acceptEdits":
      return "Edits";
    case "bypassAll":
      return "All";
  }
}

export function permissionModeHelp(m: ProjectPermissionMode): string {
  switch (m) {
    case "ask":
      return "Ask before each tool. (Custom permission UI is upcoming; for now Bash and similar tools will error in chat.)";
    case "acceptEdits":
      return "Auto-accept file edits (Read/Write/Edit). Bash and other tools still error until permission UI lands.";
    case "bypassAll":
      return "Allow every tool without prompting. Use on projects you fully trust the agent in.";
  }
}

/**
 * Default human-friendly title for a session given its mode. Spec-mode
 * sessions are singletons per project, so they're just "Chat"; code-mode
 * sessions are numbered.
 */
export function defaultSessionTitle(mode: SessionMode, ordinal: number): string {
  return mode === "spec" ? "Chat" : `Code session ${ordinal}`;
}

/** Extract the trailing folder name from an absolute path. */
export function folderNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Sort sessions for tab display: most-recently-active first, falling back to
 * startedAt then id for stable ordering when timestamps are missing.
 */
export function sortSessions(a: Session, b: Session): number {
  const at = a.lastMessageAt ?? a.startedAt ?? "";
  const bt = b.lastMessageAt ?? b.startedAt ?? "";
  if (at === bt) return a.id.localeCompare(b.id);
  return bt.localeCompare(at);
}

/**
 * Sort projects: most-recently-opened first.
 */
export function sortProjects(a: Project, b: Project): number {
  const at = a.lastOpenedAt ?? "";
  const bt = b.lastOpenedAt ?? "";
  if (at === bt) return a.name.localeCompare(b.name);
  return bt.localeCompare(at);
}
