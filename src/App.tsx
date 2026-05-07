import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  ChatItem,
  PermissionRequestPayload,
  SdkEvent,
  SidecarOutbound,
} from "./types";
import { sdkEventToChatItems } from "./sdkToChatItems";
import {
  parseQuestions,
  parseTasks,
  previewMarkdown,
} from "./specParsers";
import type { SpecQuestion, SpecTask } from "./specParsers";
import { Markdown } from "./Markdown";
import { UpdateBanner } from "./UpdateBanner";
import { VersionFooter } from "./VersionFooter";
import {
  APP_STATE_VERSION,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_PROJECT_COLOR,
  PROJECT_COLORS,
  PROJECT_COLOR_DOT_CLS,
  codebaseViewIdForProject,
  defaultSessionTitle,
  diffViewIdForProject,
  folderNameFromPath,
  isCodebaseViewId,
  isDiffViewId,
  isProductViewId,
  isProjectViewId,
  isTaskViewId,
  isTasksViewId,
  newId,
  nowIso,
  parseTaskViewId,
  productViewIdForProject,
  sortProjects,
  sortSessions,
  taskViewIdForProject,
  tasksViewIdForProject,
} from "./state";
import type {
  AppPersistedState,
  Project,
  ProjectColor,
  Session,
  SessionMode,
} from "./state";

// ---------- shared types ----------

// SpecFiles + EMPTY_SPEC removed — Phase B/C use ProductSpec and CodebaseSpec.

type ProjectKind = {
  hasExistingCode: boolean;
  kind: string | null;
};

/**
 * In-flight task — folder at `.spec/tasks/TASK-NNN/`. Each has its own
 * requirements, open questions, and a checklist of subtasks. The dashboard
 * derives the display name from the H1 in requirements.md, falling back
 * to the id.
 */
type Task = {
  id: string;
  requirements: string;
  questions: string;
  subtasks: string;
};

/** `.spec/product/*.md` — what we're building, plain language. */
type ProductSpec = {
  overview: string;
  users: string;
  goals: string;
  decisions: string;
};

const EMPTY_PRODUCT: ProductSpec = {
  overview: "",
  users: "",
  goals: "",
  decisions: "",
};

/** `.spec/codebase/*.md` — how the system is built. Features are listed
 * separately via list_features. */
type CodebaseSpec = {
  overview: string;
  architecture: string;
  decisions: string;
};

const EMPTY_CODEBASE: CodebaseSpec = {
  overview: "",
  architecture: "",
  decisions: "",
};

/** Existing feature, file at `.spec/codebase/features/FEAT-NNN.md`. */
type Feature = {
  id: string;
  content: string;
};

/** Currently-selected node within the Product tab's tree. */
type ProductNode = "overview" | "users" | "goals" | "decisions";

/** Currently-selected node within the Codebase tab's tree. */
type CodebaseNode =
  | { kind: "overview" }
  | { kind: "architecture" }
  | { kind: "decisions" }
  | { kind: "feature"; id: string };

/** One entry in the project's git status — a file with pending changes. */
type GitFileChange = {
  path: string;
  /**
   * "modified" | "added" | "deleted" | "renamed" | "copied" | "unmerged" |
   * "untracked" | "unknown"
   */
  status: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  staged: boolean;
};

type GitRemote = { name: string; url: string };

type GitChanges = {
  /** False when the project's folder isn't a git repo. */
  hasRepo: boolean;
  branch: string | null;
  /** `origin` remote, or null when none is configured. */
  remote: GitRemote | null;
  files: GitFileChange[];
};

const EMPTY_GIT: GitChanges = {
  hasRepo: false,
  branch: null,
  remote: null,
  files: [],
};

/**
 * A predefined "activity" the user is starting from a UI affordance — like
 * + Add topic. When an activity is pending, the next outgoing message is
 * wrapped with the activity's marker so the agent recognizes which flow to
 * run. Add new activities here and in the ACTIVITIES table below.
 */
type Activity =
  | { kind: "task_creation" }
  | { kind: "map_codebase" }
  | { kind: "define_product" }
  | { kind: "task_refine"; taskId: string; taskName: string }
  | { kind: "task_complete"; taskId: string; taskName: string };

function activityLabel(a: Activity): string {
  switch (a.kind) {
    case "task_creation":
      return "Creating new task";
    case "map_codebase":
      return "Mapping codebase";
    case "define_product":
      return "Defining product";
    case "task_refine":
      return `Working on ${a.taskId}: ${a.taskName}`;
    case "task_complete":
      return `Completing ${a.taskId}: ${a.taskName}`;
  }
}

function activityDescription(a: Activity): string {
  switch (a.kind) {
    case "task_creation":
      return "Describe what it's about; the agent will ask scoping questions before creating the folder.";
    case "map_codebase":
      return "The agent will scan the project and write the initial codebase spec — overview, architecture, and feature files.";
    case "define_product":
      return "Describe what the product is, who it's for, what success looks like. The agent will ask product-shaping questions and write the product spec.";
    case "task_refine":
      return "Add any extra notes, or just send to continue from the task's current state.";
    case "task_complete":
      return "Folding outcomes into product/ and codebase/. Review the changes, then click Remove folder to finish.";
  }
}

/** Prepended to the message sent to the agent — one line, on its own. */
function activityMarker(a: Activity): string {
  switch (a.kind) {
    case "task_creation":
      return "[Creating a new task]";
    case "map_codebase":
      return "[Map codebase]";
    case "define_product":
      return "[Define product]";
    case "task_refine":
      return `[Working on ${a.taskId}: ${a.taskName}]`;
    case "task_complete":
      return `[Fold and complete ${a.taskId}: ${a.taskName}]`;
  }
}

/**
 * Most activities are one-shot — the marker frames the first message and
 * we drop the activity afterwards. task_complete is sticky: it persists
 * across turns so the "Remove folder" button stays visible until the user
 * either removes the folder or cancels the activity.
 */
function isStickyActivity(a: Activity): boolean {
  return a.kind === "task_complete";
}

/**
 * Build the text actually sent to the agent. With an activity, prepend its
 * marker; if the user typed extra notes, append them under it.
 */
function composeAgentText(activity: Activity | null, text: string): string {
  if (!activity) return text;
  const marker = activityMarker(activity);
  return text ? `${marker}\n\n${text}` : marker;
}

/**
 * Build the text shown in the chat as the user's message. The activity
 * marker is hidden from the UI; if the user typed extra notes, those
 * become the bubble. With activity but no notes, fall back to the
 * activity's label so the bubble isn't empty.
 */
function composeDisplayText(activity: Activity | null, text: string): string {
  if (text) return text;
  if (activity) return activityLabel(activity);
  return "";
}

function extractTaskName(md: string, fallbackId: string): string {
  const m = /^#\s+(.*\S)\s*$/m.exec(md);
  return m?.[1]?.trim() ?? fallbackId;
}

/** Tauri event payload from Rust (snake_case-renamed to camelCase). */
type SidecarEventPayload = {
  sessionId: string;
  line: string;
};

type SessionExitPayload = {
  sessionId: string;
};

/** Drives the in-app confirm modal. window.confirm is suppressed in Tauri's WebView. */
type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
};

let userMsgCounter = 0;
function nextUserItemId(): string {
  userMsgCounter += 1;
  return `u${userMsgCounter.toString(36)}`;
}

// ---------- top-level component ----------

export default function App(): ReactElement {
  // Persisted state.
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Volatile, in-memory state.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatItem[]>
  >({});
  const [busyBySession, setBusyBySession] = useState<Record<string, boolean>>(
    {},
  );
  const [product, setProduct] = useState<ProductSpec>(EMPTY_PRODUCT);
  const [codebase, setCodebase] = useState<CodebaseSpec>(EMPTY_CODEBASE);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectKind, setProjectKind] = useState<ProjectKind | null>(null);
  const [input, setInput] = useState("");
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  /**
   * Per-session queued prompt: stored when the user clicks "Queue" while a
   * turn is in flight; auto-sent when that turn completes. We track which
   * activity (if any) was pending when the message was queued so the auto-
   * flush wraps with the right marker.
   */
  type QueuedPrompt = { text: string; activity: Activity | null };
  const [queuedPromptBySession, setQueuedPromptBySession] = useState<
    Record<string, QueuedPrompt>
  >({});
  const queuedPromptBySessionRef = useRef<Record<string, QueuedPrompt>>({});
  queuedPromptBySessionRef.current = queuedPromptBySession;

  /**
   * The currently-pending activity (or null). Set when the user clicks an
   * activity-starting affordance like "+ Add topic"; cleared when the next
   * outgoing message is sent (or queued, or canceled). The next outgoing
   * message is wrapped with the activity's marker for the agent.
   */
  const [pendingActivity, setPendingActivity] = useState<Activity | null>(
    null,
  );

  /**
   * Permission request queue. Each entry is an emitted permission_request
   * tagged with its source session id. The PermissionModal displays the
   * first item; resolutions remove items in order.
   */
  const [permissionQueue, setPermissionQueue] = useState<
    Array<PermissionRequestPayload & { sessionId: string }>
  >([]);

  // Late-bound reference to sendForSession so handleOutbound (declared above
  // sendForSession in this file) can invoke it without creating a temporal-
  // dead-zone reference in its dep array. Assigned right after sendForSession
  // is created.
  const sendForSessionRef = useRef<
    | ((
        sessionId: string,
        agentText: string,
        displayText?: string,
      ) => Promise<void>)
    | null
  >(null);

  // Same trick for newSession — referenced by startActivity and possibly
  // other callbacks declared above newSession's definition.
  const newSessionRef = useRef<
    ((mode: SessionMode, title?: string) => Session | null) | null
  >(null);

  // Refs for values needed in async callbacks without re-binding.
  const projectsRef = useRef<Project[]>(projects);
  projectsRef.current = projects;
  const sessionsRef = useRef<Session[]>(sessions);
  sessionsRef.current = sessions;
  const selectedProjectIdRef = useRef<string | null>(null);
  selectedProjectIdRef.current = selectedProjectId;
  const selectedSessionIdRef = useRef<string | null>(null);
  selectedSessionIdRef.current = selectedSessionId;

  // ---------- hydrate on mount ----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await invoke<AppPersistedState>("load_app_state");
        if (cancelled) return;
        // Migrate older state files that don't have permissionMode on each
        // project (the field was added later).
        const projects = (loaded.projects ?? []).map((p) => ({
          ...p,
          permissionMode:
            (p as Partial<Project>).permissionMode ?? DEFAULT_PERMISSION_MODE,
          color: (p as Partial<Project>).color ?? DEFAULT_PROJECT_COLOR,
        })) as Project[];
        setProjects(projects);
        setSessions(loaded.sessions ?? []);
        // Pick a sensible starting selection. New default: land on the
        // project's dashboard rather than its most-recent session — the
        // dashboard is the project's home page.
        const sortedProjects = [...projects].sort(sortProjects);
        const startProject = sortedProjects[0] ?? null;
        if (startProject) {
          setSelectedProjectId(startProject.id);
          setSelectedSessionId(productViewIdForProject(startProject.id));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("load_app_state failed:", err);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- debounced save on changes ----------

  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hydrated) return; // Don't write back before we've finished loading.
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      const payload: AppPersistedState = {
        version: APP_STATE_VERSION,
        projects,
        sessions,
      };
      invoke("save_app_state", { state: payload }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("save_app_state failed:", err);
      });
    }, 400);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [hydrated, projects, sessions]);

  // ---------- spec file refresh ----------

  const refreshSpec = useCallback(async (): Promise<void> => {
    const projId = selectedProjectIdRef.current;
    const project = projId
      ? projectsRef.current.find((p) => p.id === projId)
      : null;
    if (!project) {
      setProduct(EMPTY_PRODUCT);
      setCodebase(EMPTY_CODEBASE);
      setFeatures([]);
      setTasks([]);
      return;
    }
    try {
      const [productSpec, codebaseSpec, featureList, taskList] =
        await Promise.all([
          invoke<ProductSpec>("read_product", { cwd: project.path }),
          invoke<CodebaseSpec>("read_codebase", { cwd: project.path }),
          invoke<Feature[]>("list_features", { cwd: project.path }),
          invoke<Task[]>("list_tasks", { cwd: project.path }),
        ]);
      setProduct(productSpec);
      setCodebase(codebaseSpec);
      setFeatures(featureList);
      setTasks(taskList);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("refreshSpec failed:", err);
    }
  }, []);

  const removeTask = useCallback(
    async (id: string): Promise<void> => {
      const projId = selectedProjectIdRef.current;
      const project = projId
        ? projectsRef.current.find((p) => p.id === projId)
        : null;
      if (!project) return;
      try {
        await invoke("remove_task", { cwd: project.path, id });
        await refreshSpec();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("remove_task failed:", err);
      }
    },
    [refreshSpec],
  );

  /**
   * "+ Add topic" entry point: switches to (or creates) the project's spec
   * session, seeds the composer with the topic-creation phrase, and focuses
   * it. The agent's prompt knows to recognize this opening and start the
   * scoping flow rather than treat it as a regular requirement.
   *
   * Uses newSessionRef to avoid a TDZ reference — newSession is declared
   * later in this file.
   */
  /**
   * Start an activity in the spec session. Switches to the spec session,
   * sets the pending activity (so the next message is wrapped with its
   * marker), and focuses the composer. Activities can carry payload —
   * task_refine carries the task id + name so the marker references it.
   */
  const startActivity = useCallback((activity: Activity): void => {
    const projId = selectedProjectIdRef.current;
    if (!projId) return;
    newSessionRef.current?.("spec");
    setPendingActivity(activity);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(
        "[data-composer-input]",
      );
      el?.focus();
    });
  }, []);

  const cancelActivity = useCallback((): void => {
    setPendingActivity(null);
  }, []);

  /**
   * "Open in chat" affordance on a task card. Sets a parametrized
   * task_refine activity in the spec session — the next outgoing message
   * is wrapped with `[Working on TASK-XY: Name]`. Input is left empty;
   * the user can just send to start, or type extra notes first.
   */
  const refineTask = useCallback(
    (id: string, name: string): void => {
      startActivity({ kind: "task_refine", taskId: id, taskName: name });
    },
    [startActivity],
  );

  // Refresh spec when the selected project changes, and start a Rust-side
  // filesystem watcher on the project's .spec/ tree so external edits
  // (Claude mid-turn, the user editing in their own editor, git pull,
  // remove_task, etc.) are reflected without forcing a project switch or
  // a manual git-refresh click. The watcher is debounced backend-side.
  useEffect(() => {
    void refreshSpec();
    const projId = selectedProjectId;
    const project = projId
      ? projectsRef.current.find((p) => p.id === projId)
      : null;
    if (!project) {
      void invoke("unwatch_spec").catch(() => {});
      return;
    }
    void invoke("watch_spec", { cwd: project.path }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("watch_spec failed:", err);
    });
    return () => {
      void invoke("unwatch_spec").catch(() => {});
    };
  }, [selectedProjectId, refreshSpec]);

  // Subscribe to the spec-watcher event the Rust side emits on every
  // debounced burst of .spec/ filesystem changes. We re-check the current
  // project against the payload so a late-firing event from a watcher
  // that's already been replaced can't overwrite state with stale data.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ cwd: string }>("spec-files-changed", (e) => {
      const projId = selectedProjectIdRef.current;
      const project = projId
        ? projectsRef.current.find((p) => p.id === projId)
        : null;
      if (!project || project.path !== e.payload.cwd) return;
      void refreshSpec();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("spec-files-changed listen failed:", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshSpec]);

  // Detect "is this an existing-code project?" so the empty-state can offer
  // a one-click "map this codebase" action on fresh spec sessions.
  useEffect(() => {
    const proj = projectsRef.current.find((p) => p.id === selectedProjectId);
    if (!proj) {
      setProjectKind(null);
      return;
    }
    let cancelled = false;
    invoke<ProjectKind>("detect_project_kind", { cwd: proj.path })
      .then((k) => {
        if (!cancelled) setProjectKind(k);
      })
      .catch(() => {
        if (!cancelled) setProjectKind(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  // ---------- history restore on session selection ----------
  //
  // When a session is selected that has an sdkSessionId from a previous run
  // but no in-memory messages (typical right after app start), ask the
  // sidecar to replay the SDK's persisted messages so the chat view fills
  // in. Tracked per-session so we don't loop or double-load.
  const historyAttemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated) return;
    const sessId = selectedSessionId;
    if (!sessId) return;
    if (historyAttemptedRef.current.has(sessId)) return;
    const sess = sessionsRef.current.find((s) => s.id === sessId);
    if (!sess || !sess.sdkSessionId) return;
    if ((messagesBySession[sessId] ?? []).length > 0) return;
    const proj = projectsRef.current.find((p) => p.id === sess.projectId);
    if (!proj) return;

    historyAttemptedRef.current.add(sessId);
    invoke("load_session_history", {
      sessionId: sess.id,
      cwd: proj.path,
      sdkSessionId: sess.sdkSessionId,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("load_session_history failed:", err);
      // Allow retry on the next selection.
      historyAttemptedRef.current.delete(sessId);
    });
  }, [hydrated, selectedSessionId, messagesBySession]);

  // ---------- sidecar event subscriptions ----------

  useEffect(() => {
    let cancelled = false;
    const fns: Array<() => void> = [];

    const subscribe = async (): Promise<void> => {
      const u1 = await listen<SidecarEventPayload>("sidecar-event", (e) => {
        const { sessionId, line } = e.payload;
        let msg: SidecarOutbound;
        try {
          msg = JSON.parse(line) as SidecarOutbound;
        } catch (err) {
          appendItem(sessionId, {
            kind: "error",
            message: `failed to parse sidecar event: ${(err as Error).message}`,
            id: nextUserItemId(),
          });
          return;
        }
        handleOutbound(sessionId, msg);
      });
      if (cancelled) return u1();
      fns.push(u1);

      const u2 = await listen<SidecarEventPayload>("sidecar-stderr", (e) => {
        // eslint-disable-next-line no-console
        console.debug(`[sidecar ${e.payload.sessionId} stderr]`, e.payload.line);
      });
      if (cancelled) return u2();
      fns.push(u2);

      const u3 = await listen<SessionExitPayload>("sidecar-exit", (e) => {
        const sid = e.payload.sessionId;
        setBusyBySession((prev) => ({ ...prev, [sid]: false }));
        // The sidecar is gone — drop any pending permission requests for
        // this session so the modal doesn't get stuck waiting on a process
        // that can't respond.
        setPermissionQueue((prev) => prev.filter((r) => r.sessionId !== sid));
      });
      if (cancelled) return u3();
      fns.push(u3);
    };

    void subscribe();
    return () => {
      cancelled = true;
      for (const fn of fns) fn();
      fns.length = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appendItem = useCallback((sessionId: string, item: ChatItem): void => {
    setMessagesBySession((prev) => {
      const existing = prev[sessionId] ?? [];
      // Dedupe consecutive user-kind items with identical text. The
      // host adds a user item locally on send; the SDK then echoes the
      // same prompt as a user event during live streaming. Without
      // this, every send produces two user bubbles.
      if (item.kind === "user" && existing.length > 0) {
        for (let i = existing.length - 1; i >= 0; i -= 1) {
          const prior = existing[i];
          if (!prior || prior.kind !== "user") break;
          if (prior.text === item.text) return prev;
        }
      }
      return { ...prev, [sessionId]: [...existing, item] };
    });
  }, []);

  const handleOutbound = useCallback(
    (sessionId: string, msg: SidecarOutbound): void => {
      if (msg.kind === "ready") return;

      if (msg.kind === "permission_request") {
        // Push onto the queue tagged with the source session.
        setPermissionQueue((prev) => [...prev, { ...msg, sessionId }]);
        return;
      }

      if (msg.kind === "sdk") {
        const ev: SdkEvent = msg.event;
        // Capture SDK session id on first init for resume.
        if (
          ev.type === "system" &&
          ev.subtype === "init" &&
          typeof ev.session_id === "string"
        ) {
          const sdkId = ev.session_id;
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId && s.sdkSessionId !== sdkId
                ? { ...s, sdkSessionId: sdkId }
                : s,
            ),
          );
        }
        const newItems = sdkEventToChatItems(ev);
        if (newItems.length > 0) {
          setMessagesBySession((prev) => {
            const existing = prev[sessionId] ?? [];
            return { ...prev, [sessionId]: [...existing, ...newItems] };
          });
        }
        // After a `result` event, refresh spec for the current project IF
        // this session was spec-mode AND this is the currently visible session.
        if (ev.type === "result") {
          const sess = sessionsRef.current.find((s) => s.id === sessionId);
          if (
            sess &&
            sess.mode === "spec" &&
            sess.projectId === selectedProjectIdRef.current
          ) {
            void refreshSpec();
            // Also (re)attach the spec watcher: on the very first turn,
            // .spec/ likely didn't exist when watch_spec was called from
            // the project-change effect, so the watcher is currently a
            // no-op. The Rust side is idempotent, so this is cheap when
            // the watcher is already healthy.
            const proj = projectsRef.current.find((p) => p.id === sess.projectId);
            if (proj) {
              void invoke("watch_spec", { cwd: proj.path }).catch(() => {});
            }
          }
          // Stamp lastMessageAt.
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId ? { ...s, lastMessageAt: nowIso() } : s,
            ),
          );
        }
        return;
      }

      if (msg.kind === "fatal") {
        appendItem(sessionId, {
          kind: "error",
          message: msg.message,
          id: nextUserItemId(),
        });
        setBusyBySession((prev) => ({ ...prev, [sessionId]: false }));
        return;
      }

      if (msg.kind === "done") {
        setBusyBySession((prev) => ({ ...prev, [sessionId]: false }));
        // Auto-flush a queued prompt for this session, if any.
        const queued = queuedPromptBySessionRef.current[sessionId];
        if (queued) {
          setQueuedPromptBySession((prev) => {
            if (!(sessionId in prev)) return prev;
            const next = { ...prev };
            delete next[sessionId];
            return next;
          });
          // Defer to next tick so the busy-clear renders before the next
          // send re-busies the session — keeps the UI from flashing.
          queueMicrotask(() => {
            const agentText = composeAgentText(queued.activity, queued.text);
            const displayText = composeDisplayText(queued.activity, queued.text);
            void sendForSessionRef.current?.(sessionId, agentText, displayText);
          });
        }
        return;
      }
    },
    [appendItem, refreshSpec],
  );

  // ---------- project / session actions ----------

  /**
   * Register a path as a project, dedupe-ing on existing entries. Used
   * by both `addProject` (folder picker) and `addProjectFromGit` (clone
   * to parent → cloned subfolder is the new project's path).
   */
  const registerProjectAtPath = useCallback((path: string): void => {
    const existing = projectsRef.current.find((p) => p.path === path);
    if (existing) {
      setSelectedProjectId(existing.id);
      setSelectedSessionId(productViewIdForProject(existing.id));
      setProjects((prev) =>
        prev.map((p) =>
          p.id === existing.id ? { ...p, lastOpenedAt: nowIso() } : p,
        ),
      );
      return;
    }
    const proj: Project = {
      id: newId(),
      name: folderNameFromPath(path),
      path,
      lastOpenedAt: nowIso(),
      permissionMode: DEFAULT_PERMISSION_MODE,
      color: DEFAULT_PROJECT_COLOR,
    };
    setProjects((prev) => [...prev, proj]);
    setSelectedProjectId(proj.id);
    setSelectedSessionId(productViewIdForProject(proj.id));
  }, []);

  const addProject = useCallback(async (): Promise<void> => {
    const result = await open({ directory: true, multiple: false });
    if (typeof result !== "string") return;
    registerProjectAtPath(result);
  }, [registerProjectAtPath]);

  /**
   * Clone a Git URL into a user-chosen parent folder, then register the
   * cloned subfolder as a project. Throws on clone failure so the
   * caller (Dashboard) can show the error inline.
   */
  const addProjectFromGit = useCallback(
    async (url: string): Promise<void> => {
      const trimmed = url.trim();
      if (!trimmed) throw new Error("Repo URL is empty");
      const parent = await open({ directory: true, multiple: false });
      if (typeof parent !== "string") return;
      const cloned = await invoke<string>("git_clone_to_parent", {
        parentDir: parent,
        url: trimmed,
      });
      registerProjectAtPath(cloned);
    },
    [registerProjectAtPath],
  );

  const removeProject = useCallback((projectId: string): void => {
    // Stop any sidecars belonging to this project's sessions.
    const toStop = sessionsRef.current
      .filter((s) => s.projectId === projectId)
      .map((s) => s.id);
    for (const sid of toStop) {
      void invoke("stop_session", { sessionId: sid });
    }
    setSessions((prev) => prev.filter((s) => s.projectId !== projectId));
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setMessagesBySession((prev) => {
      const next = { ...prev };
      for (const sid of toStop) delete next[sid];
      return next;
    });
    if (selectedProjectIdRef.current === projectId) {
      setSelectedProjectId(null);
      setSelectedSessionId(null);
    }
  }, []);

  const selectProject = useCallback((projectId: string): void => {
    setSelectedProjectId(projectId);
    // Always land on the dashboard when switching projects. The user can
    // click a session tab to dive in.
    setSelectedSessionId(productViewIdForProject(projectId));
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, lastOpenedAt: nowIso() } : p)),
    );
  }, []);

  const newSession = useCallback(
    (mode: SessionMode, title?: string): Session | null => {
      const projId = selectedProjectIdRef.current;
      if (!projId) return null;
      // Singleton chat per project: if one already exists, just select it.
      // (Planning-only mode — we no longer create non-spec sessions, but
      // legacy persisted sessions of other modes are still respected.)
      if (mode === "spec") {
        const existing = sessionsRef.current.find(
          (s) => s.projectId === projId && s.mode === "spec",
        );
        if (existing) {
          setSelectedSessionId(existing.id);
          return existing;
        }
      }
      const ordinal =
        sessionsRef.current.filter((s) => s.projectId === projId).length + 1;
      const sess: Session = {
        id: newId(),
        projectId: projId,
        sdkSessionId: null,
        title: title ?? defaultSessionTitle(mode, ordinal),
        mode,
        startedAt: nowIso(),
        lastMessageAt: null,
      };
      setSessions((prev) => [...prev, sess]);
      setSelectedSessionId(sess.id);
      return sess;
    },
    [],
  );
  // Keep the late-bound ref pointing at the latest newSession instance.
  newSessionRef.current = newSession;

  const closeSession = useCallback((sessionId: string): void => {
    void invoke("stop_session", { sessionId });
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setMessagesBySession((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    if (selectedSessionIdRef.current === sessionId) {
      const projId = selectedProjectIdRef.current;
      const fallback = sessionsRef.current
        .filter((s) => s.projectId === projId && s.id !== sessionId)
        .sort(sortSessions)[0];
      setSelectedSessionId(fallback?.id ?? null);
    }
  }, []);

  // ---------- send / stop ----------

  /**
   * Internal: send a specific text into a specific session. Used by both the
   * Send button and the queue auto-flush. Does NOT consult the input field
   * (caller decides what to send).
   *
   * `agentText` is what's sent to the agent; `displayText` is what shows in
   * the chat as the user's message. They differ when the message is wrapped
   * with the `[Creating a new topic]` marker — we hide the marker from the
   * UI but keep it in what the agent receives. Defaults to the same string.
   */
  const sendForSession = useCallback(
    async (
      sessionId: string,
      agentText: string,
      displayText?: string,
    ): Promise<void> => {
      const sess = sessionsRef.current.find((s) => s.id === sessionId);
      const proj = projectsRef.current.find((p) => p.id === sess?.projectId);
      if (!sess || !proj || !agentText.trim()) return;
      appendItem(sess.id, {
        kind: "user",
        text: displayText ?? agentText,
        id: nextUserItemId(),
      });
      setBusyBySession((prev) => ({ ...prev, [sess.id]: true }));
      try {
        // Permissions are auto-managed for the planning-only app: the
        // agent only writes inside .spec/ (enforced by the prompt + the
        // sidecar's PreToolUse hook), so acceptEdits is always safe.
        // The user no longer cycles modes — there's no UI for it.
        await invoke("send_message", {
          sessionId: sess.id,
          cwd: proj.path,
          prompt: agentText,
          resume: sess.sdkSessionId,
          mode: sess.mode,
          permissionMode: "acceptEdits",
        });
      } catch (err) {
        appendItem(sess.id, {
          kind: "error",
          message: String(err),
          id: nextUserItemId(),
        });
        setBusyBySession((prev) => ({ ...prev, [sess.id]: false }));
      }
    },
    [appendItem],
  );
  // Keep the late-bound ref pointing at the latest sendForSession instance.
  sendForSessionRef.current = sendForSession;

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    const sessId = selectedSessionIdRef.current;
    if (!sessId) return;
    const activity = pendingActivity;
    // Allow sending with empty input as long as there's an activity — the
    // marker alone is a meaningful message ("start working on TASK-XY").
    if (!text && !activity) return;
    if (busyBySession[sessId]) return;
    setInput("");
    if (activity && !isStickyActivity(activity)) setPendingActivity(null);
    const agentText = composeAgentText(activity, text);
    const displayText = composeDisplayText(activity, text);
    await sendForSession(sessId, agentText, displayText);
  }, [input, busyBySession, sendForSession, pendingActivity]);

  /**
   * Stash the current input as a queued message for the active session. When
   * the in-flight turn finishes, the queue auto-flushes (see the "done" arm
   * of handleOutbound). Single-slot per session — re-queuing overwrites.
   * Captures the pending activity so the auto-flush wraps correctly.
   */
  const queueMessage = useCallback((): void => {
    const text = input.trim();
    const sessId = selectedSessionIdRef.current;
    if (!sessId) return;
    const activity = pendingActivity;
    if (!text && !activity) return;
    setQueuedPromptBySession((prev) => ({
      ...prev,
      [sessId]: { text, activity },
    }));
    if (activity && !isStickyActivity(activity)) setPendingActivity(null);
    setInput("");
  }, [input, pendingActivity]);

  const cancelQueued = useCallback((): void => {
    const sessId = selectedSessionIdRef.current;
    if (!sessId) return;
    setQueuedPromptBySession((prev) => {
      if (!(sessId in prev)) return prev;
      const next = { ...prev };
      delete next[sessId];
      return next;
    });
  }, []);

  /**
   * Resolve the topmost permission request in the queue. Sends a
   * permission_response down the session's sidecar stdin via the Rust
   * respond_to_session command, then pops the queue entry.
   */
  const resolvePermission = useCallback(
    async (decision: "allow" | "deny"): Promise<void> => {
      const head = permissionQueue[0];
      if (!head) return;
      try {
        await invoke("respond_to_session", {
          sessionId: head.sessionId,
          body: JSON.stringify({
            kind: "permission_response",
            request_id: head.request_id,
            decision,
            ...(decision === "deny" ? { message: "Denied by user" } : {}),
          }),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("respond_to_session failed:", err);
      }
      setPermissionQueue((prev) => prev.slice(1));
    },
    [permissionQueue],
  );

  const stop = useCallback(async (): Promise<void> => {
    const sessId = selectedSessionIdRef.current;
    if (!sessId) return;
    try {
      await invoke("stop_session", { sessionId: sessId });
    } finally {
      setBusyBySession((prev) => ({ ...prev, [sessId]: false }));
    }
  }, []);

  const focusComposer = useCallback((): void => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>("[data-composer-input]")
        ?.focus();
    });
  }, []);

  /**
   * Create a fresh spec session and focus the composer — for users who want
   * to describe the project themselves rather than have the agent map it.
   */
  const startSpecAndDescribe = useCallback((): void => {
    if (!selectedProjectIdRef.current) return;
    newSession("spec");
    focusComposer();
  }, [newSession, focusComposer]);

  // ---------- keyboard shortcuts ----------
  //
  //   Cmd/Ctrl-N            → open / create the project chat
  //   Cmd/Ctrl-W            → close current session (with confirm)
  //   Cmd/Ctrl-K            → focus composer
  //   Cmd/Ctrl-1..9         → switch to the Nth tab in the current project
  //
  // All handlers preventDefault when they match so the WebView's native
  // bindings (e.g. Cmd-W → close window) don't fire instead.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      const projId = selectedProjectIdRef.current;
      const sessId = selectedSessionIdRef.current;

      if (e.key === "n" || e.key === "N") {
        if (!projId) return;
        e.preventDefault();
        // Planning-only: there's just one chat per project. newSession
        // handles the singleton — opens the existing chat or creates it.
        newSession("spec");
        return;
      }
      if (e.key === "w" || e.key === "W") {
        if (!sessId) return;
        // Spec view isn't a closeable tab — bail.
        if (isProjectViewId(sessId)) return;
        e.preventDefault();
        const sess = sessionsRef.current.find((s) => s.id === sessId);
        setConfirmReq({
          title: "Close session?",
          body: `"${sess?.title ?? "this session"}" will be removed from the tab strip. The SDK session is preserved on disk and you can resume it later.`,
          confirmLabel: "Close",
          destructive: true,
          onConfirm: () => closeSession(sessId),
        });
        return;
      }
      if (e.key === "k" || e.key === "K") {
        const el = document.querySelector<HTMLTextAreaElement>(
          "[data-composer-input]",
        );
        if (el) {
          e.preventDefault();
          el.focus();
          // Move caret to end so prefilled "Re: question..." text doesn't get
          // selected away.
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
        return;
      }
      if (/^[1-9]$/.test(e.key) && projId) {
        const idx = Number.parseInt(e.key, 10) - 1;
        const projSessions = sessionsRef.current
          .filter((s) => s.projectId === projId)
          .sort(sortSessions);
        const target = projSessions[idx];
        if (target) {
          e.preventDefault();
          setSelectedSessionId(target.id);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newSession, closeSession]);

  // ---------- project mutations: recolor, rename ----------

  const setProjectColor = useCallback(
    (id: string, color: ProjectColor): void => {
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, color } : p)),
      );
    },
    [],
  );

  const renameProject = useCallback((id: string, name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
    );
  }, []);

  // ---------- derived ----------

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const projectSessions = useMemo(
    () =>
      selectedProjectId
        ? sessions
            .filter((s) => s.projectId === selectedProjectId)
            .sort(sortSessions)
        : [],
    [sessions, selectedProjectId],
  );
  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const visibleMessages = useMemo<ChatItem[]>(
    () => (selectedSessionId ? messagesBySession[selectedSessionId] ?? [] : []),
    [messagesBySession, selectedSessionId],
  );
  const isBusy = selectedSessionId
    ? Boolean(busyBySession[selectedSessionId])
    : false;
  // Project-level open-questions are gone in the new model — questions
  // belong inside tasks now. The legacy side-panel was removed; flows are
  // surfaced from the Product/Codebase/Tasks tabs and the spec session is
  // just chat.
  const isProductView = isProductViewId(selectedSessionId);
  const isCodebaseView = isCodebaseViewId(selectedSessionId);
  const isTasksView = isTasksViewId(selectedSessionId);
  const isTaskView = isTaskViewId(selectedSessionId);
  const isDiffView = isDiffViewId(selectedSessionId);
  /** Task currently open in the detail view; null on any other tab. */
  const selectedTaskId = useMemo<string | null>(() => {
    const parsed = parseTaskViewId(selectedSessionId);
    return parsed?.taskId ?? null;
  }, [selectedSessionId]);

  /**
   * The file currently open as a diff tab in the main panel — set when
   * the user clicks a row in the git panel. One per project at a time;
   * clicking another file replaces it. Closing the diff tab clears
   * this and falls back to the chat view.
   */
  const [openDiffPath, setOpenDiffPath] = useState<string | null>(null);

  /**
   * Selected node within the Product / Codebase tabs. Lifted out of
   * those views (where it used to be local state) because the new left
   * sidebar drives navigation and needs to display + change selection.
   */
  const [productNode, setProductNode] = useState<ProductNode>("overview");
  const [codebaseNode, setCodebaseNode] = useState<CodebaseNode>({
    kind: "overview",
  });
  // Reset when project changes — view selection is project-local.
  useEffect(() => {
    setOpenDiffPath(null);
    setProductNode("overview");
    setCodebaseNode({ kind: "overview" });
  }, [selectedProjectId]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * Floating composer height. Tracked dynamically so the chat scroll's
   * bottom padding always matches the actual composer footprint —
   * otherwise a multi-line input or activity banner hides the last
   * messages permanently. ResizeObserver attached via callback ref so
   * the observer follows the DOM node across project/view switches.
   */
  const [composerHeight, setComposerHeight] = useState(140);
  const composerObsRef = useRef<ResizeObserver | null>(null);
  const setComposerWrapNode = useCallback(
    (node: HTMLDivElement | null): void => {
      composerObsRef.current?.disconnect();
      composerObsRef.current = null;
      if (!node) return;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setComposerHeight(entry.contentRect.height);
        }
      });
      ro.observe(node);
      composerObsRef.current = ro;
    },
    [],
  );

  // Auto-scroll on new messages — but only when the user is already
  // pinned near the bottom. If they've scrolled up to read earlier
  // context (or to copy something), the agent streaming new chunks
  // should NOT yank them back down. Same threshold logic re-runs when
  // the composer grows, so a longer input still keeps the latest line
  // visible without disrupting an upward-reading user.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Threshold accounts for the floating composer overlap plus a bit
    // of breathing room.
    const nearBottom = distanceFromBottom < composerHeight + 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [visibleMessages, composerHeight]);

  // ---------- render ----------

  // Derive active sidebar tab from the current selection sentinel.
  // Defaults to "chat" so unknown / session-id selections route to chat.
  const activeTab: "product" | "codebase" | "tasks" | "chat" =
    isProductView
      ? "product"
      : isCodebaseView
        ? "codebase"
        : isTasksView || isTaskView
          ? "tasks"
          : "chat";

  return (
    <div className="flex h-full flex-row bg-[rgb(34_34_37)] text-zinc-200">
      {!selectedProject && <DashboardHeader />}
      {selectedProject ? (
        <ProjectSidebar
          project={selectedProject}
          onBack={() => {
            setSelectedProjectId(null);
            setSelectedSessionId(null);
          }}
          onSetProjectColor={setProjectColor}
          onRenameProject={renameProject}
          onRemoveProject={(id, name) =>
            setConfirmReq({
              title: "Remove project from Outset?",
              body: `"${name}" will be removed from the dashboard. The folder on disk is untouched, and any sessions tied to it will be closed.`,
              confirmLabel: "Remove",
              destructive: true,
              onConfirm: () => removeProject(id),
            })
          }
          activeTab={activeTab}
          onSelectTab={(t) => {
            if (t === "product")
              setSelectedSessionId(productViewIdForProject(selectedProject.id));
            else if (t === "codebase")
              setSelectedSessionId(codebaseViewIdForProject(selectedProject.id));
            else if (t === "tasks")
              setSelectedSessionId(tasksViewIdForProject(selectedProject.id));
            else newSession("spec");
          }}
          product={product}
          productNode={productNode}
          onSelectProductNode={(n) => {
            setProductNode(n);
            setSelectedSessionId(productViewIdForProject(selectedProject.id));
          }}
          codebase={codebase}
          features={features}
          codebaseNode={codebaseNode}
          onSelectCodebaseNode={(n) => {
            setCodebaseNode(n);
            setSelectedSessionId(codebaseViewIdForProject(selectedProject.id));
          }}
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelectTask={(taskId) => {
            setSelectedSessionId(
              taskViewIdForProject(selectedProject.id, taskId),
            );
          }}
          onAddTask={() => startActivity({ kind: "task_creation" })}
          sessions={projectSessions}
          selectedSessionId={selectedSessionId}
          busyMap={busyBySession}
          onSelectOrCreateChat={() => newSession("spec")}
        />
      ) : null}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-1 flex-col overflow-hidden">
            {selectedProject ? (
              <>
                {/* Diff tab strip — shown only when a file diff is open. */}
                {openDiffPath && (
                  <DiffTabStrip
                    path={openDiffPath}
                    selected={isDiffView}
                    onSelect={() =>
                      setSelectedSessionId(
                        diffViewIdForProject(selectedProject.id),
                      )
                    }
                    onClose={() => {
                      setOpenDiffPath(null);
                      if (isDiffView) {
                        setSelectedSessionId(
                          productViewIdForProject(selectedProject.id),
                        );
                      }
                    }}
                  />
                )}
                {isProductView ? (
                  <ProductView
                    project={selectedProject}
                    product={product}
                    selected={productNode}
                    onDefineProduct={() =>
                      startActivity({ kind: "define_product" })
                    }
                  />
                ) : isCodebaseView ? (
                  <CodebaseView
                    project={selectedProject}
                    codebase={codebase}
                    features={features}
                    selected={codebaseNode}
                    onMapCodebase={() =>
                      startActivity({ kind: "map_codebase" })
                    }
                  />
                ) : isTasksView ? (
                  <div className="scrollbar-thin flex-1 overflow-y-auto">
                    <TasksView
                      project={selectedProject}
                      tasks={tasks}
                      onAddTask={() => startActivity({ kind: "task_creation" })}
                      onRefineTask={refineTask}
                      onOpenTask={(taskId) =>
                        setSelectedSessionId(
                          taskViewIdForProject(selectedProject.id, taskId),
                        )
                      }
                    />
                  </div>
                ) : isTaskView ? (
                  <div className="scrollbar-thin flex-1 overflow-y-auto">
                    <TaskDetailView
                      project={selectedProject}
                      task={
                        tasks.find((t) => t.id === selectedTaskId) ?? null
                      }
                      taskIdSelected={selectedTaskId}
                      onBack={() =>
                        setSelectedSessionId(
                          tasksViewIdForProject(selectedProject.id),
                        )
                      }
                      onRefine={refineTask}
                    />
                  </div>
                ) : isDiffView && openDiffPath ? (
                  <DiffFileView
                    project={selectedProject}
                    path={openDiffPath}
                  />
                ) : (
                  <div className="relative flex flex-1 flex-col overflow-hidden">
                    <div
                      ref={scrollRef}
                      className="scrollbar-thin flex-1 overflow-y-auto px-8 pt-8"
                      style={{ paddingBottom: `${composerHeight + 24}px` }}
                    >
                      {selectedSession ? (
                        visibleMessages.length === 0 ? (
                          <ChatEmptyState mode={selectedSession.mode} />
                        ) : (
                          <div className="mx-auto flex max-w-3xl flex-col gap-3">
                            {groupChatItems(visibleMessages).map((seg, i) =>
                              seg.kind === "tool_group" ? (
                                <ToolGroupView
                                  key={`g${i}-${seg.items[0]?.id ?? ""}`}
                                  items={seg.items}
                                />
                              ) : (
                                <ItemView key={seg.item.id} item={seg.item} />
                              ),
                            )}
                            {isBusy && <BusyIndicator />}
                          </div>
                        )
                      ) : (
                        <NoSessionState
                          onNew={newSession}
                          projectKind={projectKind}
                          hasExistingSpec={
                            product.overview.trim().length > 0
                          }
                          onMapCodebase={() =>
                            startActivity({ kind: "map_codebase" })
                          }
                          onDescribe={startSpecAndDescribe}
                        />
                      )}
                    </div>
                    <div
                      ref={setComposerWrapNode}
                      className="pointer-events-none absolute inset-x-0 bottom-0"
                    >
                      <div className="pointer-events-auto">
                    <Composer
                      value={input}
                      onChange={setInput}
                      onSend={send}
                      onStop={stop}
                      onQueue={queueMessage}
                      onCancelQueue={cancelQueued}
                      queuedText={
                        selectedSessionId
                          ? queuedPromptBySession[selectedSessionId]?.text ??
                            null
                          : null
                      }
                      disabled={!selectedSession}
                      busy={isBusy}
                      mode={selectedSession?.mode ?? "spec"}
                      activity={pendingActivity}
                      onCancelActivity={cancelActivity}
                      onStartTaskCompletion={(id, name) =>
                        setConfirmReq({
                          title: "Mark task complete?",
                          body: `Claude will fold ${id} (${name})'s outcomes into the relevant feature files, add a Decisions entry, and update product/ if user-facing. Once that's done you can review and click Remove folder.`,
                          confirmLabel: "Fold and complete",
                          onConfirm: () => {
                            const sessId = selectedSessionIdRef.current;
                            if (!sessId) return;
                            const a: Activity = {
                              kind: "task_complete",
                              taskId: id,
                              taskName: name,
                            };
                            setPendingActivity(a);
                            void sendForSession(
                              sessId,
                              activityMarker(a),
                              activityLabel(a),
                            );
                          },
                        })
                      }
                      onRemoveTaskFolder={(id, name) =>
                        setConfirmReq({
                          title: "Remove task folder?",
                          body: `${id} (${name}) will be deleted from disk. Do this once you're satisfied with the fold into product/ and codebase/. The work history stays in git.`,
                          confirmLabel: "Remove folder",
                          destructive: true,
                          onConfirm: () => {
                            setPendingActivity(null);
                            void removeTask(id);
                          },
                        })
                      }
                    />
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <Dashboard
                projects={projects}
                onSelect={selectProject}
                onAdd={addProject}
                onAddFromGit={addProjectFromGit}
                onRemove={(id, name) =>
                  setConfirmReq({
                    title: "Remove project from Outset?",
                    body: `"${name}" will be removed from the dashboard. The folder on disk is untouched, and any sessions tied to it will be closed.`,
                    confirmLabel: "Remove",
                    destructive: true,
                    onConfirm: () => removeProject(id),
                  })
                }
                onSetColor={setProjectColor}
                onRename={renameProject}
              />
            )}
          </div>
          {selectedProject && (
            <GitPanel
              project={selectedProject}
              currentDiffPath={openDiffPath}
              onOpenFile={(path) => {
                setOpenDiffPath(path);
                setSelectedSessionId(diffViewIdForProject(selectedProject.id));
              }}
            />
          )}
        </div>
      </div>
      <ConfirmModal req={confirmReq} onClose={() => setConfirmReq(null)} />
      <PermissionModal
        request={permissionQueue[0] ?? null}
        queueLength={permissionQueue.length}
        onResolve={resolvePermission}
      />
      {/* UpdateBanner is now mounted inline — see ProjectSidebar's
          bottom slot for the in-project view, and Dashboard's footer
          for the no-project view. */}
    </div>
  );
}

// ---------- presentational components ----------

/**
 * Dashboard top bar — shown when no project is selected. Just the app
 * title; the macOS traffic lights overlay the left side (titleBarStyle:
 * "Overlay" + hiddenTitle in tauri.conf.json), so we leave a 80px
 * left-pad to clear them.
 */
function DashboardHeader(): ReactElement {
  return (
    <header
      data-tauri-drag-region
      className="flex h-10 flex-none items-center pl-20 pr-4"
    >
      <div className="text-[13px] font-semibold tracking-tight">Outset</div>
      <div className="ml-2 text-[11px] text-zinc-500">v0.0.1</div>
    </header>
  );
}

/**
 * Minimal inline SVG icons for the project-level tabs. Stroked, currentColor,
 * 14×14 — small enough to sit beside text without dominating it.
 */
function IconProduct(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <circle cx="8" cy="8" r="6.25" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    </svg>
  );
}
function IconCodebase(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M5.5 4.5 2 8l3.5 3.5" />
      <path d="M10.5 4.5 14 8l-3.5 3.5" />
    </svg>
  );
}
function IconTasks(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="m2.5 5 1.5 1.5L7 3.5" />
      <path d="M9.5 5h4" />
      <path d="m2.5 11 1.5 1.5L7 9.5" />
      <path d="M9.5 11h4" />
    </svg>
  );
}
function IconChat(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M2.5 6.5a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3h-3l-2.5 2v-2h-0.5a3 3 0 0 1-2-1" />
    </svg>
  );
}

/* Sidebar section icons — small, monoline, all 14×14. Used by
 * SpecTreeItem in the Product/Codebase inner sidebars. */
function IconOverview(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M3 4h10" />
      <path d="M3 8h10" />
      <path d="M3 12h6" />
    </svg>
  );
}
function IconUsers(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <circle cx="8" cy="6" r="2.4" />
      <path d="M3.5 13c.6-2.2 2.4-3.5 4.5-3.5s3.9 1.3 4.5 3.5" />
    </svg>
  );
}
function IconGoals(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M4 13V3" />
      <path d="M4 3h7l-1.5 2.5L11 8H4" />
    </svg>
  );
}
function IconDecisions(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="m3 5 1.5 1.5L7.5 3.5" />
      <path d="M9.5 5h3.5" />
      <path d="m3 11 1.5 1.5L7.5 9.5" />
      <path d="M9.5 11h3.5" />
    </svg>
  );
}
function IconArchitecture(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <rect x="2.5" y="3" width="11" height="3" rx="0.5" />
      <rect x="2.5" y="7.5" width="6" height="3" rx="0.5" />
      <rect x="9.5" y="7.5" width="4" height="6" rx="0.5" />
      <rect x="2.5" y="11.5" width="6" height="2" rx="0.5" />
    </svg>
  );
}
function IconFeature(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <path d="M8 2.5 9.6 6l3.4.5-2.5 2.4.6 3.6L8 10.8 4.9 12.5l.6-3.6L3 6.5 6.4 6Z" />
    </svg>
  );
}

/**
 * Left-hand project sidebar. Replaces the old top-of-window header +
 * tab strip. Hosts:
 *   - Drag region with traffic-light spacing at top
 *   - Project title row (back · color dot · name)
 *   - Tab strip: Product | Codebase | Tasks | Chat
 *   - Tab-specific list below: subsections, task list, sessions list
 *   - Settings (⋮) button at the bottom for rename / perms / remove
 *
 * One sidebar drives all project navigation; the main content panel is
 * just the body of whichever node/task/session is selected.
 */
function ProjectSidebar({
  project,
  onBack,
  onSetProjectColor,
  onRenameProject,
  onRemoveProject,
  // Tab state
  activeTab,
  onSelectTab,
  // Product tab
  product,
  productNode,
  onSelectProductNode,
  // Codebase tab
  codebase,
  features,
  codebaseNode,
  onSelectCodebaseNode,
  // Tasks tab
  tasks,
  selectedTaskId,
  onSelectTask,
  onAddTask,
  // Chat tab
  sessions,
  selectedSessionId,
  busyMap,
  onSelectOrCreateChat,
}: {
  project: Project;
  onBack: () => void;
  onSetProjectColor: (id: string, c: ProjectColor) => void;
  onRenameProject: (id: string, name: string) => void;
  onRemoveProject: (id: string, name: string) => void;
  activeTab: "product" | "codebase" | "tasks" | "chat";
  onSelectTab: (t: "product" | "codebase" | "tasks" | "chat") => void;
  product: ProductSpec;
  productNode: ProductNode;
  onSelectProductNode: (n: ProductNode) => void;
  codebase: CodebaseSpec;
  features: Feature[];
  codebaseNode: CodebaseNode;
  onSelectCodebaseNode: (n: CodebaseNode) => void;
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onAddTask: () => void;
  sessions: Session[];
  selectedSessionId: string | null;
  busyMap: Record<string, boolean>;
  onSelectOrCreateChat: () => void;
}): ReactElement {
  // Triggers inline rename on the project name label. Bumped by the
  // Settings dropdown's "Rename" item — `window.prompt` doesn't work in
  // Tauri's WebView, so we drive the existing RenameableLabel instead.
  const [renameTrigger, setRenameTrigger] = useState(0);
  return (
    <aside className="my-2 ml-2 flex w-[252px] flex-none flex-col overflow-hidden rounded-lg bg-[rgb(42_42_46)] ring-1 ring-zinc-700/60">
      {/* Traffic-light pad. macOS lights overlay this region — they sit
          on the card surface (slightly lighter than canvas), which reads
          fine in dark mode. */}
      <div data-tauri-drag-region className="h-7 flex-none" />

      {/* Project title row */}
      <div
        data-tauri-drag-region
        className="flex flex-none items-center gap-2 px-3 py-1.5"
      >
        <button
          onClick={onBack}
          title="Back to projects"
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M10 12 6 8l4-4" />
          </svg>
        </button>
        <ColorDot
          color={project.color}
          onPick={(c) => onSetProjectColor(project.id, c)}
          size="md"
        />
        <RenameableLabel
          value={project.name}
          onRename={(next) => onRenameProject(project.id, next)}
          className="min-w-0 flex-1 truncate text-[14px] font-medium text-zinc-100"
          inputClassName="block w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[14px] text-zinc-100 focus:border-zinc-500 focus:outline-none"
          title={`${project.path}\n(double-click to rename)`}
          editTrigger={renameTrigger}
        />
      </div>

      {/* Tab strip */}
      <div className="grid flex-none grid-cols-4 gap-1 px-2 pb-1.5 pt-0.5">
        <SidebarTab
          icon={<IconProduct />}
          label="Product"
          active={activeTab === "product"}
          onClick={() => onSelectTab("product")}
        />
        <SidebarTab
          icon={<IconCodebase />}
          label="Codebase"
          active={activeTab === "codebase"}
          onClick={() => onSelectTab("codebase")}
        />
        <SidebarTab
          icon={<IconTasks />}
          label="Tasks"
          active={activeTab === "tasks"}
          onClick={() => onSelectTab("tasks")}
        />
        <SidebarTab
          icon={<IconChat />}
          label="Chat"
          active={activeTab === "chat"}
          onClick={() => onSelectTab("chat")}
        />
      </div>

      <div className="border-b border-zinc-700/30" />

      {/* Tab-specific list */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {activeTab === "product" ? (
          <ul className="flex flex-col gap-0.5">
            {(Object.keys(PRODUCT_NODE_LABELS) as ProductNode[]).map((k) => (
              <SpecTreeItem
                key={k}
                icon={iconForProductNode(k)}
                label={PRODUCT_NODE_LABELS[k]}
                active={productNode === k}
                empty={product[k].trim().length === 0}
                onClick={() => onSelectProductNode(k)}
              />
            ))}
          </ul>
        ) : activeTab === "codebase" ? (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-0.5">
              <SpecTreeItem
                icon={<IconOverview />}
                label="Overview"
                active={codebaseNode.kind === "overview"}
                empty={codebase.overview.trim().length === 0}
                onClick={() => onSelectCodebaseNode({ kind: "overview" })}
              />
              <SpecTreeItem
                icon={<IconArchitecture />}
                label="Architecture"
                active={codebaseNode.kind === "architecture"}
                empty={codebase.architecture.trim().length === 0}
                onClick={() =>
                  onSelectCodebaseNode({ kind: "architecture" })
                }
              />
              <SpecTreeItem
                icon={<IconDecisions />}
                label="Decisions"
                active={codebaseNode.kind === "decisions"}
                empty={codebase.decisions.trim().length === 0}
                onClick={() => onSelectCodebaseNode({ kind: "decisions" })}
              />
            </ul>
            <div>
              <SidebarHeading>
                Features{features.length > 0 ? ` (${features.length})` : ""}
              </SidebarHeading>
              <ul className="mt-1 flex flex-col gap-0.5">
                {features.length === 0 ? (
                  <li className="px-2 py-1 text-[11px] italic text-zinc-500">
                    No features yet
                  </li>
                ) : (
                  features.map((f) => (
                    <SpecTreeItem
                      key={f.id}
                      icon={<IconFeature />}
                      label={extractFeatureName(f)}
                      subtitle={f.id}
                      active={
                        codebaseNode.kind === "feature" &&
                        codebaseNode.id === f.id
                      }
                      onClick={() =>
                        onSelectCodebaseNode({ kind: "feature", id: f.id })
                      }
                    />
                  ))
                )}
              </ul>
            </div>
          </div>
        ) : activeTab === "tasks" ? (
          <div className="flex flex-col gap-1">
            {tasks.length === 0 ? (
              <div className="px-2 py-1 text-[11px] italic text-zinc-500">
                No tasks yet
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {tasks.map((t) => (
                  <SpecTreeItem
                    key={t.id}
                    icon={<IconTasks />}
                    label={extractTaskName(t.requirements, t.id)}
                    subtitle={t.id}
                    active={selectedTaskId === t.id}
                    onClick={() => onSelectTask(t.id)}
                  />
                ))}
              </ul>
            )}
            <button
              onClick={onAddTask}
              className="mt-1 rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
            >
              + Add task
            </button>
          </div>
        ) : (
          // chat tab — singleton project chat (no code sessions in
          // planning-only mode; the user implements in their editor)
          <ChatSessionsList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            busyMap={busyMap}
            onSelectOrCreateChat={onSelectOrCreateChat}
          />
        )}
      </div>

      {/* Update banner — shown only when an update is available, sits
          directly above the settings divider so it's prominent without
          competing with chat content. */}
      <div className="flex-none px-2 pb-2 empty:hidden">
        <UpdateBanner />
      </div>

      {/* Bottom: settings (⋮) */}
      <div className="flex-none border-t border-zinc-700/30 p-2">
        <ProjectSettingsButton
          project={project}
          onStartRename={() => setRenameTrigger((n) => n + 1)}
          onRemoveProject={onRemoveProject}
        />
      </div>
    </aside>
  );
}

function SidebarTab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[10.5px] tracking-tight transition-colors ${
        active
          ? "bg-[rgb(58_58_64)] text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
          : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * Sidebar list under the Chat tab. After the planning-only pivot
 * there's just the singleton project chat — no code sessions — but
 * we keep this as a separate component so the row can grow features
 * (search, history, etc.) later without ProjectSidebar inflating.
 */
function ChatSessionsList({
  sessions,
  selectedSessionId,
  busyMap,
  onSelectOrCreateChat,
}: {
  sessions: Session[];
  selectedSessionId: string | null;
  busyMap: Record<string, boolean>;
  onSelectOrCreateChat: () => void;
}): ReactElement {
  const specSession = sessions.find((s) => s.mode === "spec") ?? null;
  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={onSelectOrCreateChat}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
          specSession && selectedSessionId === specSession.id
            ? "bg-[rgb(58_58_64)] text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
            : specSession
              ? "text-zinc-300 hover:bg-zinc-800/50"
              : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
        }`}
        title={
          specSession
            ? "Project chat"
            : "No chat yet — click to start"
        }
      >
        <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center text-current">
          <IconChat />
          {specSession && Boolean(busyMap[specSession.id]) && (
            <span className="absolute -right-0.5 -top-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">Project chat</span>
      </button>
    </div>
  );
}

function ProjectSettingsButton({
  project,
  onStartRename,
  onRemoveProject,
}: {
  project: Project;
  /** Triggers inline rename on the project-name label in the sidebar. */
  onStartRename: () => void;
  onRemoveProject: (id: string, name: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      const t = e.target as HTMLElement | null;
      if (!t?.closest("[data-settings-menu]")) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  function startRename(): void {
    setOpen(false);
    onStartRename();
  }
  return (
    <span data-settings-menu className="relative block">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Settings"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 flex-none"
        >
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1.5v2" />
          <path d="M8 12.5v2" />
          <path d="M1.5 8h2" />
          <path d="M12.5 8h2" />
          <path d="m3.5 3.5 1.4 1.4" />
          <path d="m11.1 11.1 1.4 1.4" />
          <path d="m12.5 3.5-1.4 1.4" />
          <path d="m4.9 11.1-1.4 1.4" />
        </svg>
        <span>Settings</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-1 overflow-hidden rounded-lg bg-zinc-800 py-1 text-[13px] text-zinc-100 shadow-xl ring-1 ring-zinc-700/60">
          <button
            onClick={startRename}
            className="block w-full px-3 py-1.5 text-left hover:bg-zinc-700/60"
          >
            Rename
          </button>
          <div className="my-1 border-t border-zinc-700/60" />
          <button
            onClick={() => {
              setOpen(false);
              onRemoveProject(project.id, project.name);
            }}
            className="block w-full px-3 py-1.5 text-left text-red-300 hover:bg-red-900/30"
          >
            Remove project
          </button>
        </div>
      )}
    </span>
  );
}

/**
 * Project dashboard — the no-project state. Lists every project as a
 * clickable row, plus an "+ Add project" affordance. Replaces the
 * standalone project sidebar; once you click into a project the layout
 * switches to ProjectHeader + content (no sidebar).
 */
function Dashboard({
  projects,
  onSelect,
  onAdd,
  onAddFromGit,
  onRemove,
  onSetColor,
  onRename,
}: {
  projects: Project[];
  onSelect: (id: string) => void;
  onAdd: () => void;
  /**
   * Clone a Git URL → register the cloned subfolder as a project.
   * Pops a folder dialog for the parent folder; throws on failure so
   * we can display the error inline next to the URL input.
   */
  onAddFromGit: (url: string) => Promise<void>;
  onRemove: (id: string, name: string) => void;
  onSetColor: (id: string, c: ProjectColor) => void;
  onRename: (id: string, name: string) => void;
}): ReactElement {
  // Inline state for the "+ From Git" affordance. Folded out into a
  // small URL input row when the user clicks the button; submitting
  // pops the parent-folder picker and clones.
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);

  async function submitClone(): Promise<void> {
    const url = cloneUrl.trim();
    if (!url || cloning) return;
    setCloning(true);
    setCloneErr(null);
    try {
      await onAddFromGit(url);
      setCloneUrl("");
      setCloneOpen(false);
    } catch (e) {
      setCloneErr(String(e));
    } finally {
      setCloning(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-8 pb-16 pt-10">
          <div className="mb-6 flex items-baseline justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
              Projects
            </h1>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setCloneErr(null);
                  setCloneOpen((v) => !v);
                }}
                className="rounded-md bg-zinc-800/70 px-3 py-1.5 text-[12.5px] text-zinc-200 ring-1 ring-zinc-700/60 transition-colors hover:bg-zinc-800"
              >
                + From Git
              </button>
              <button
                onClick={onAdd}
                className="rounded-md bg-zinc-800/70 px-3 py-1.5 text-[12.5px] text-zinc-200 ring-1 ring-zinc-700/60 transition-colors hover:bg-zinc-800"
              >
                + Add project
              </button>
            </div>
          </div>

        {cloneOpen && (
          <div className="mb-6 rounded-xl bg-zinc-800/30 p-3 ring-1 ring-zinc-800/60">
            <div className="mb-2 text-[12.5px] text-zinc-400">
              Clone a Git repository — you'll pick the parent folder next; the
              repo is cloned into a new subfolder there.
            </div>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitClone();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCloneOpen(false);
                    setCloneErr(null);
                  }
                }}
                placeholder="git@github.com:user/repo.git"
                className="min-w-0 flex-1 rounded bg-zinc-900/60 px-2 py-1 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600 ring-1 ring-zinc-700/60 focus:outline-none focus:ring-zinc-500"
              />
              <button
                onClick={() => void submitClone()}
                disabled={cloning || !cloneUrl.trim()}
                className="rounded bg-zinc-100 px-2.5 py-1 text-[12px] font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
              >
                {cloning ? "Cloning…" : "Clone"}
              </button>
              <button
                onClick={() => {
                  setCloneOpen(false);
                  setCloneErr(null);
                }}
                className="rounded px-1.5 py-1 text-[12px] text-zinc-500 hover:text-zinc-200"
              >
                Cancel
              </button>
            </div>
            {cloneErr && (
              <div className="mt-2 rounded-md bg-red-950/40 px-2 py-1.5 text-[11px] text-red-200 ring-1 ring-red-800/50">
                {cloneErr}
              </div>
            )}
          </div>
        )}
        {projects.length === 0 ? (
          <div className="rounded-xl bg-zinc-800/30 px-6 py-12 text-center text-sm text-zinc-500 ring-1 ring-zinc-800/60">
            No projects yet. Click{" "}
            <span className="font-mono">+ Add project</span> to pick a folder.
            <div className="mt-2 text-xs text-zinc-600">
              Outset works against folders on your disk.
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((p) => (
              <li
                key={p.id}
                className="group relative flex items-center gap-3 rounded-xl bg-zinc-800/30 px-4 py-3 ring-1 ring-zinc-800/60 transition-colors hover:bg-zinc-800/60"
              >
                <ColorDot
                  color={p.color}
                  onPick={(c) => onSetColor(p.id, c)}
                  size="md"
                />
                <button
                  onClick={() => onSelect(p.id)}
                  className="flex min-w-0 flex-1 flex-col items-start text-left"
                >
                  <RenameableLabel
                    value={p.name}
                    onRename={(next) => onRename(p.id, next)}
                    className="block max-w-full truncate text-[16px] font-medium text-zinc-100"
                    inputClassName="block w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[16px] text-zinc-100 focus:border-zinc-500 focus:outline-none"
                    title="Double-click to rename"
                  />
                  <div
                    className="block max-w-full truncate font-mono text-[11px] text-zinc-500"
                    title={p.path}
                  >
                    {p.path}
                  </div>
                </button>
                <button
                  onClick={() => onRemove(p.id, p.name)}
                  className="invisible flex-none rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-red-900/30 hover:text-red-200 group-hover:visible"
                  title="Remove from Outset"
                >
                  ×
                </button>
                <span className="flex-none text-zinc-500 transition-colors group-hover:text-zinc-300">
                  →
                </span>
              </li>
            ))}
          </ul>
        )}
        </div>
      </div>
      {/* Pinned footer: update card (when an update is available) and
          the version. The scroll area above keeps the project list
          scrollable while the version stays visible at the bottom of
          the dashboard chrome. */}
      <div className="flex-none px-4 pb-1 empty:hidden">
        <div className="mx-auto max-w-2xl">
          <UpdateBanner />
        </div>
      </div>
      <VersionFooter />
    </div>
  );
}

function NoSessionState({
  onNew,
  projectKind,
  hasExistingSpec,
  onMapCodebase,
  onDescribe,
}: {
  onNew: (mode: SessionMode) => void;
  projectKind: ProjectKind | null;
  hasExistingSpec: boolean;
  onMapCodebase: () => void;
  onDescribe: () => void;
}): ReactElement {
  // Headline case: an existing-code project that doesn't have a spec
  // yet. Skip the generic "no sessions" UI and go straight to the
  // mapping decision — that's the more useful next step here.
  if (projectKind?.hasExistingCode === true && !hasExistingSpec) {
    const kindLabel = projectKind.kind ?? "existing";
    const article = /^[aeiou]/i.test(kindLabel) ? "an" : "a";
    return (
      <div className="flex h-full items-center justify-center text-center">
        <div className="max-w-md">
          <div className="mb-2 text-lg font-medium text-zinc-200">
            Looks like {article} {kindLabel} project
          </div>
          <div className="mb-5 text-sm leading-relaxed text-zinc-400">
            Want me to map the codebase first? Claude will scan the layout,
            build tooling, and README — then ask scoped questions about what
            you want to build, modify, or change.
          </div>
          <div className="mb-4 flex justify-center gap-2">
            <button
              onClick={onMapCodebase}
              className="rounded-md border border-emerald-700 bg-emerald-900/40 px-4 py-1.5 text-sm font-medium text-emerald-100 hover:bg-emerald-900/60"
            >
              Map the codebase
            </button>
            <button
              onClick={onDescribe}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              I'll describe it instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Default: empty project (or one that already has a spec). Outset is
  // planning-only — the singleton project Chat is the only session.
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="max-w-md text-zinc-400">
        <div className="mb-2 text-lg font-medium text-zinc-200">
          {hasExistingSpec ? "Pick up where you left off" : "No chat yet"}
        </div>
        <div className="mb-4 text-sm leading-relaxed">
          {hasExistingSpec
            ? "There's already a .spec/ folder here. Open the project Chat to keep refining it; implement tasks in your editor when you're ready."
            : "Open the project Chat. Claude drafts and maintains a `.spec/` folder of product, codebase, and task notes; you implement in your own editor."}
        </div>
        <div className="flex justify-center gap-2">
          <button
            onClick={() => onNew("spec")}
            className="rounded-md border border-emerald-800 bg-emerald-950/50 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-900/50"
          >
            + Chat
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatEmptyState(_: { mode: SessionMode }): ReactElement {
  // Code sessions are gone; only the project Chat (spec mode) exists,
  // so the empty-state copy is unconditionally about that.
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="max-w-md text-zinc-400">
        <div className="mb-2 text-lg font-medium text-zinc-200">
          Project chat
        </div>
        <div className="text-sm leading-relaxed">
          Describe what you want to build, or use the Product / Codebase /
          Tasks tabs to start a specific flow. Claude will draft and
          maintain the .spec/ folder; you implement tasks in your editor.
        </div>
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onQueue,
  onCancelQueue,
  queuedText,
  disabled,
  busy,
  mode,
  activity,
  onCancelActivity,
  onStartTaskCompletion,
  onRemoveTaskFolder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onQueue: () => void;
  onCancelQueue: () => void;
  queuedText: string | null;
  disabled: boolean;
  busy: boolean;
  mode: SessionMode;
  activity: Activity | null;
  onCancelActivity: () => void;
  /**
   * Click handler for the "✓ Mark complete" button in a task_refine
   * banner. The parent transitions the activity to task_complete and
   * sends the fold-and-complete marker so the agent does the work.
   */
  onStartTaskCompletion: (taskId: string, taskName: string) => void;
  /**
   * Click handler for the "🗑 Remove folder" button in a task_complete
   * banner. The parent confirms, deletes the folder, and clears the
   * activity.
   */
  onRemoveTaskFolder: (taskId: string, taskName: string) => void;
}): ReactElement {
  // Auto-resize the textarea to fit content, up to a sensible max.
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const trimmed = value.trim();
  // With an activity set, the marker itself is a valid message — empty
  // input is OK (the input acts as an optional notes field).
  const hasContent = trimmed.length > 0 || activity !== null;
  const canSend = !disabled && !busy && hasContent;
  const canQueue = !disabled && busy && hasContent;
  const placeholder = disabled
    ? "Open the project chat to start…"
    : busy
      ? "Type a follow-up — it'll send when this turn finishes"
      : activity
        ? "Add notes (optional) — Cmd-Enter to send"
        : "Describe what you want to build — Cmd-Enter to send";
  // `mode` is kept on the prop for backward compat with persisted
  // sessions, but planning-only means it's effectively always "spec".
  void mode;

  return (
    <div className="px-8 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        <div
          className={`rounded-2xl bg-zinc-800/80 px-3 pt-2 pb-2 ring-1 backdrop-blur-md transition-colors focus-within:ring-zinc-600 ${
            activity ? "ring-emerald-700/70" : "ring-zinc-700/40"
          }`}
        >
          {activity && (
            <div className="mb-2 flex items-start gap-2.5 rounded-lg bg-emerald-950/40 px-3 py-2 text-emerald-100 ring-1 ring-emerald-800/60">
              <span className="mt-1.5 inline-block h-2 w-2 flex-none rounded-full bg-emerald-400" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold leading-snug text-emerald-100">
                  {activityLabel(activity)}
                </div>
                <div className="mt-0.5 text-[13px] leading-snug text-emerald-200/80">
                  {activityDescription(activity)}
                </div>
              </div>
              <div className="flex flex-none items-center gap-1.5">
                {activity.kind === "task_refine" && (
                  <button
                    onClick={() =>
                      onStartTaskCompletion(activity.taskId, activity.taskName)
                    }
                    className="rounded-md bg-emerald-900/40 px-2.5 py-1 text-[12.5px] text-emerald-100 ring-1 ring-emerald-700/70 transition-colors hover:bg-emerald-900/70"
                    title="Ask Claude to fold this task's outcomes into product/ and codebase/, then remove the folder."
                  >
                    ✓ Mark complete
                  </button>
                )}
                {activity.kind === "task_complete" && (
                  <button
                    onClick={() =>
                      onRemoveTaskFolder(activity.taskId, activity.taskName)
                    }
                    className="rounded-md bg-emerald-900/40 px-2.5 py-1 text-[12.5px] text-emerald-100 ring-1 ring-emerald-700/70 transition-colors hover:bg-emerald-900/70"
                    title="Delete the task folder. Do this after Claude has folded the outcomes into the spec."
                  >
                    🗑 Remove folder
                  </button>
                )}
                <button
                  onClick={onCancelActivity}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[14px] text-emerald-300/70 transition-colors hover:bg-emerald-900/60 hover:text-emerald-100"
                  title="Cancel"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {queuedText && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-400">
              <span className="text-zinc-500">Queued —</span>
              <span className="flex-1 truncate" title={queuedText}>
                {queuedText}
              </span>
              <button
                onClick={onCancelQueue}
                className="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                title="Cancel queued message"
              >
                ×
              </button>
            </div>
          )}
          <textarea
            ref={taRef}
            data-composer-input="true"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (busy) {
                  if (canQueue) onQueue();
                } else if (canSend) {
                  onSend();
                }
              }
            }}
            rows={1}
            placeholder={placeholder}
            disabled={disabled}
            className="block max-h-60 w-full resize-none bg-transparent px-1 py-1 font-sans text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-50"
          />
          <div className="mt-1 flex items-center justify-between">
            {/* Bottom-left: + attach + permission chip. The chip is
                surfaced here (rather than in the project header) so the
                user sees current permissions exactly when they're about
                to send work to the agent. */}
            <div className="flex items-center gap-1.5">
              <button
                disabled
                title="Attach (coming soon)"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-lg text-zinc-500 transition-colors hover:bg-zinc-700/60 hover:text-zinc-300 disabled:cursor-not-allowed"
              >
                +
              </button>
            </div>
            {/* Bottom-right: Stop (when busy) + Send/Queue. */}
            <div className="flex items-center gap-1.5">
              {busy && (
                <button
                  onClick={onStop}
                  className="flex h-9 items-center rounded-lg bg-red-900/40 px-3.5 text-[13px] text-red-100 ring-1 ring-red-800/60 transition-colors hover:bg-red-900/70"
                  title="Stop this turn"
                >
                  Stop
                </button>
              )}
              {busy ? (
                <button
                  onClick={onQueue}
                  disabled={!canQueue}
                  className="flex h-9 items-center rounded-lg bg-zinc-700/80 px-3.5 text-[13px] font-medium text-zinc-100 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Queue this message — sends when current turn finishes"
                >
                  Queue
                </button>
              ) : (
                <button
                  onClick={onSend}
                  disabled={!canSend}
                  title="Send (Cmd-Enter)"
                  aria-label="Send"
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-zinc-900 shadow-sm transition-all hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500 disabled:shadow-none"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                  >
                    <path d="M8 13V3" />
                    <path d="M3.5 7.5 8 3l4.5 4.5" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarHeading({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-zinc-500">
      {children}
    </div>
  );
}

// =====================================================================
// Phase-C project views: Product, Codebase, Tasks.
// =====================================================================

const PRODUCT_NODE_LABELS: Record<ProductNode, string> = {
  overview: "Overview",
  users: "Users",
  goals: "Goals",
  decisions: "Decisions",
};

function iconForProductNode(k: ProductNode): ReactElement {
  switch (k) {
    case "overview":
      return <IconOverview />;
    case "users":
      return <IconUsers />;
    case "goals":
      return <IconGoals />;
    case "decisions":
      return <IconDecisions />;
  }
}

function ProductView({
  project,
  product,
  selected,
  onDefineProduct,
}: {
  project: Project;
  product: ProductSpec;
  selected: ProductNode;
  onDefineProduct: () => void;
}): ReactElement {
  const content = product[selected];
  const empty = content.trim().length === 0;
  const allEmpty =
    product.overview.trim().length === 0 &&
    product.users.trim().length === 0 &&
    product.goals.trim().length === 0 &&
    product.decisions.trim().length === 0;
  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-8 pb-12 pt-8">
      <div className="mx-auto w-full max-w-3xl">
        <ViewHeader
          project={project}
          sectionLabel={PRODUCT_NODE_LABELS[selected]}
          action={
            <button
              onClick={onDefineProduct}
              className="rounded-md bg-emerald-900/40 px-3 py-1.5 text-[12.5px] text-emerald-200 ring-1 ring-emerald-800/60 transition-colors hover:bg-emerald-900/60"
              title="Walk the agent through the product spec"
            >
              {allEmpty ? "+ Define product" : "+ Refine"}
            </button>
          }
        />
        {empty ? (
          <SpecEmpty
            text={
              allEmpty
                ? "No product spec yet. Click + Define product to walk the agent through it."
                : "This file is empty. Open a chat and ask the agent to draft it, or use + Refine."
            }
          />
        ) : (
          <SpecContent text={content} />
        )}
      </div>
    </div>
  );
}

function CodebaseView({
  project,
  codebase,
  features,
  selected,
  onMapCodebase,
}: {
  project: Project;
  codebase: CodebaseSpec;
  features: Feature[];
  selected: CodebaseNode;
  onMapCodebase: () => void;
}): ReactElement {
  const content =
    selected.kind === "overview"
      ? codebase.overview
      : selected.kind === "architecture"
        ? codebase.architecture
        : selected.kind === "decisions"
          ? codebase.decisions
          : (features.find((f) => f.id === selected.id)?.content ?? "");
  const sectionLabel =
    selected.kind === "overview"
      ? "Overview"
      : selected.kind === "architecture"
        ? "Architecture"
        : selected.kind === "decisions"
          ? "Decisions"
          : extractFeatureName(
              features.find((f) => f.id === selected.id) ?? {
                id: selected.id,
                content: "",
              },
            );
  const empty = content.trim().length === 0;
  const allEmpty =
    codebase.overview.trim().length === 0 &&
    codebase.architecture.trim().length === 0 &&
    codebase.decisions.trim().length === 0 &&
    features.length === 0;
  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-8 pb-12 pt-8">
      <div className="mx-auto w-full max-w-3xl">
        <ViewHeader
          project={project}
          sectionLabel={sectionLabel}
          action={
            <button
              onClick={onMapCodebase}
              className="rounded-md bg-emerald-900/40 px-3 py-1.5 text-[12.5px] text-emerald-200 ring-1 ring-emerald-800/60 transition-colors hover:bg-emerald-900/60"
              title="Have the agent scan the codebase and write the spec"
            >
              {allEmpty ? "+ Map codebase" : "+ Refine"}
            </button>
          }
        />
        {empty ? (
          <SpecEmpty
            text={
              selected.kind === "feature"
                ? "This feature file is empty."
                : allEmpty
                  ? "No codebase spec yet. Click + Map codebase to have the agent scan the project and populate it."
                  : "This file is empty."
            }
          />
        ) : (
          <SpecContent text={content} />
        )}
      </div>
    </div>
  );
}

function TasksView({
  project,
  tasks,
  onAddTask,
  onRefineTask,
  onOpenTask,
}: {
  project: Project;
  tasks: Task[];
  onAddTask: () => void;
  onRefineTask: (id: string, name: string) => void;
  /** Open the per-task detail view. Triggered by clicking a task title. */
  onOpenTask: (id: string) => void;
}): ReactElement {
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <ViewHeader
        project={project}
        sectionLabel={`Tasks${tasks.length > 0 ? ` (${tasks.length})` : ""}`}
        action={
          <button
            onClick={onAddTask}
            className="rounded-md bg-zinc-800/70 px-3 py-1.5 text-[12.5px] text-zinc-200 ring-1 ring-zinc-700/60 transition-colors hover:bg-zinc-800"
            title="Walk the agent through scoping a new task"
          >
            + Add task
          </button>
        }
      />
      {tasks.length === 0 ? (
        <div className="rounded-xl bg-zinc-800/30 px-4 py-12 text-center text-sm text-zinc-500 ring-1 ring-zinc-800/60">
          No tasks in flight. Click <span className="font-mono">+ Add task</span>{" "}
          to scope your first one.
          <div className="mt-2 text-xs text-zinc-600">
            A task is work in progress — it has its own requirements,
            questions, and subtasks. When complete, it folds into Codebase
            (features) and/or Product (user-facing changes).
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {tasks.map((t) => (
            <FsTaskCard
              key={t.id}
              task={t}
              onRefine={onRefineTask}
              onOpen={onOpenTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Right-hand git panel — shown for every project. Pulls status on mount
 * and on demand (refresh button + after commit). Lets the user click a
 * file to see its diff, write a commit message + commit, and push.
 *
 * Self-contained: it owns its own git state instead of leaning on a
 * top-level reducer, since this data is only ever displayed here and
 * git is a relatively expensive sync (shells out per call).
 */
function GitPanel({
  project,
  currentDiffPath,
  onOpenFile,
}: {
  project: Project;
  /** Path currently open in the main-panel diff tab; used to highlight. */
  currentDiffPath: string | null;
  /** Click on a file row → opens it in the main panel as a tab. */
  onOpenFile: (path: string) => void;
}): ReactElement {
  const [git, setGit] = useState<GitChanges>(EMPTY_GIT);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState<string>("");
  const [busy, setBusy] = useState<
    "commit" | "push" | "init" | "remote" | "clone" | null
  >(null);
  /**
   * Toggle for the inline origin editor. The text input it controls
   * lives a few elements below; this lets the line collapse back to
   * its summary state when the user cancels or saves.
   */
  const [editingRemote, setEditingRemote] = useState(false);
  const [remoteDraft, setRemoteDraft] = useState("");
  /** Toggle for the "Clone existing repo" inline editor (no-repo state). */
  const [cloning, setCloning] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const next = await invoke<GitChanges>("git_changes", { cwd: project.path });
      setGit(next);
    } catch (e) {
      setErr(String(e));
      setGit(EMPTY_GIT);
    } finally {
      setLoading(false);
    }
  }, [project.path]);

  // Initial load + reload whenever the project changes.
  useEffect(() => {
    setCommitMsg("");
    setFlash(null);
    setEditingRemote(false);
    setRemoteDraft("");
    setCloning(false);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function commit(): Promise<void> {
    if (!commitMsg.trim() || busy) return;
    setBusy("commit");
    setErr(null);
    try {
      const head = await invoke<string>("git_commit", {
        cwd: project.path,
        message: commitMsg.trim(),
      });
      setCommitMsg("");
      setFlash(`Committed: ${head}`);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function push(): Promise<void> {
    if (busy) return;
    setBusy("push");
    setErr(null);
    try {
      await invoke<string>("git_push", { cwd: project.path });
      setFlash("Pushed");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function initRepo(): Promise<void> {
    if (busy) return;
    setBusy("init");
    setErr(null);
    try {
      await invoke<void>("git_init", { cwd: project.path });
      setFlash("Initialized git repo with starter .gitignore");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Last-failed clone URL when the Rust side rejected with "not empty".
   * Surfacing it lets us render an inline "Clone anyway" retry button,
   * since `window.confirm` is suppressed in Tauri's WebView.
   */
  const [clonePendingUrl, setClonePendingUrl] = useState<string | null>(null);

  /**
   * Clone a repo INTO the project's existing folder (no nesting). When
   * `force` is false and the folder isn't empty, the backend rejects;
   * we capture the URL and let the user retry with force via a button.
   */
  async function cloneInto(url: string, force: boolean): Promise<void> {
    if (busy) return;
    setBusy("clone");
    setErr(null);
    try {
      await invoke<string>("git_clone_into", {
        cwd: project.path,
        url,
        forceWhenNonempty: force,
      });
      setFlash(force ? "Cloned (merged into existing folder)" : "Cloned");
      setCloning(false);
      setClonePendingUrl(null);
      await refresh();
    } catch (e) {
      const msg = String(e);
      if (!force && msg.toLowerCase().includes("not empty")) {
        // Don't treat as a hard error — surface the retry affordance.
        setClonePendingUrl(url);
        setErr(
          "Folder isn't empty. Clone anyway? Existing files will be merged with the remote tree where possible.",
        );
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(null);
    }
  }

  async function setOrigin(url: string): Promise<void> {
    if (busy) return;
    setBusy("remote");
    setErr(null);
    try {
      await invoke<void>("git_set_origin", { cwd: project.path, url });
      setFlash(git.remote ? "Updated origin" : "Added origin");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function removeOrigin(): Promise<void> {
    if (busy) return;
    setBusy("remote");
    setErr(null);
    try {
      await invoke<void>("git_remove_origin", { cwd: project.path });
      setFlash("Removed origin");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Auto-clear flash after a couple seconds.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  const totalAdds = git.files.reduce((n, f) => n + f.additions, 0);
  const totalDels = git.files.reduce((n, f) => n + f.deletions, 0);

  return (
    <aside className="scrollbar-thin my-2 mr-2 flex w-80 flex-none flex-col overflow-hidden rounded-lg bg-[rgb(42_42_46)] ring-1 ring-zinc-700/60">
      {/* Header: branch + refresh */}
      <div className="flex flex-none items-center gap-2 px-3 pt-3 pb-2">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 text-zinc-400"
        >
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="6.5" r="1.5" />
          <path d="M4.5 5v6" />
          <path d="M11.5 8c0 2-2 3-4 3" />
        </svg>
        {git.hasRepo ? (
          <span
            className="min-w-0 flex-1 truncate text-[13px] text-zinc-200"
            title={git.branch ?? ""}
          >
            <span className="text-zinc-500">Branch:</span>{" "}
            <span className="font-medium">{git.branch ?? "(detached)"}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-200">
            {loading ? "Checking…" : "Not a git repo"}
          </span>
        )}
        <button
          onClick={refresh}
          title="Refresh"
          disabled={loading}
          className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100 disabled:opacity-50"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          >
            <path d="M2.5 8a5.5 5.5 0 0 1 9.5-3.7L13 3" />
            <path d="M13 3v3h-3" />
            <path d="M13.5 8a5.5 5.5 0 0 1-9.5 3.7L3 13" />
            <path d="M3 13v-3h3" />
          </svg>
        </button>
      </div>

      {/* Remote line: shows origin URL when set, lets user edit/remove,
          or add a new one. Hidden when the folder isn't a repo. */}
      {git.hasRepo && (
        <div className="flex flex-none items-center gap-2 px-3 pb-2 text-[11px]">
          <span className="text-zinc-500">Remotes:</span>
          {editingRemote ? (
            <RemoteEditor
              initial={remoteDraft}
              busy={busy === "remote"}
              onSave={async (url) => {
                await setOrigin(url);
                setEditingRemote(false);
              }}
              onCancel={() => setEditingRemote(false)}
            />
          ) : git.remote ? (
            <>
              <span
                className="min-w-0 flex-1 truncate font-mono text-zinc-300"
                title={git.remote.url}
              >
                {git.remote.url}
              </span>
              <button
                onClick={() => {
                  setRemoteDraft(git.remote?.url ?? "");
                  setEditingRemote(true);
                }}
                className="rounded px-1 text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
                title="Edit origin URL"
              >
                Edit
              </button>
              <button
                onClick={removeOrigin}
                disabled={busy !== null}
                className="rounded px-1 text-zinc-500 hover:bg-red-900/30 hover:text-red-200 disabled:opacity-50"
                title="Remove origin remote"
              >
                ×
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                setRemoteDraft("");
                setEditingRemote(true);
              }}
              className="flex-1 rounded px-1 text-left text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
              title="Set origin URL"
            >
              + Add remote
            </button>
          )}
        </div>
      )}

      {/* Status line: file count + delta */}
      {git.hasRepo && git.files.length > 0 && (
        <div className="flex flex-none items-center gap-2 px-3 pb-2 text-[11px] text-zinc-500">
          <span>
            {git.files.length} file{git.files.length === 1 ? "" : "s"}
          </span>
          {totalAdds > 0 && <span className="text-emerald-400">+{totalAdds}</span>}
          {totalDels > 0 && <span className="text-red-400">−{totalDels}</span>}
        </div>
      )}

      {/* Errors / flash */}
      {err && (
        <div className="mx-3 mb-2 flex-none rounded-md bg-red-950/40 px-2 py-1.5 text-[11px] text-red-200 ring-1 ring-red-800/50">
          {err}
        </div>
      )}
      {flash && (
        <div className="mx-3 mb-2 flex-none rounded-md bg-emerald-950/40 px-2 py-1.5 text-[11px] text-emerald-200 ring-1 ring-emerald-800/50">
          {flash}
        </div>
      )}

      {/* File list */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!git.hasRepo ? (
          <div className="flex flex-col items-stretch gap-2 px-3 py-4 text-[12px] text-zinc-500">
            <span>This folder isn't a git repo yet.</span>
            {cloning ? (
              <RemoteEditor
                initial=""
                busy={busy === "clone"}
                onSave={(url) => cloneInto(url, false)}
                onCancel={() => {
                  setCloning(false);
                  setClonePendingUrl(null);
                  setErr(null);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={initRepo}
                  disabled={busy !== null || loading}
                  className="rounded-md bg-zinc-100 px-2.5 py-1 text-[12px] font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
                >
                  {busy === "init" ? "Initializing…" : "Initialize git repo"}
                </button>
                <button
                  onClick={() => {
                    setErr(null);
                    setClonePendingUrl(null);
                    setCloning(true);
                  }}
                  disabled={busy !== null || loading}
                  className="rounded-md border border-zinc-700 bg-transparent px-2.5 py-1 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-800/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Clone existing repo
                </button>
              </div>
            )}
            {clonePendingUrl && (
              <button
                onClick={() => cloneInto(clonePendingUrl, true)}
                disabled={busy !== null}
                className="self-start rounded-md border border-amber-700/60 bg-amber-900/30 px-2.5 py-1 text-[12px] font-medium text-amber-100 transition-colors hover:bg-amber-900/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "clone" ? "Cloning…" : "Clone anyway"}
              </button>
            )}
          </div>
        ) : git.files.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-zinc-500">
            Working tree is clean.
          </div>
        ) : (
          <ul className="px-1.5 py-0.5">
            {git.files.map((f) => (
              <li key={f.path}>
                <button
                  onClick={() => onOpenFile(f.path)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                    currentDiffPath === f.path
                      ? "bg-zinc-700/60 text-zinc-100"
                      : "text-zinc-300 hover:bg-zinc-800/60"
                  }`}
                  title={
                    f.oldPath
                      ? `${f.oldPath} → ${f.path}`
                      : f.path
                  }
                >
                  <StatusBadge status={f.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                    {f.path}
                  </span>
                  {(f.additions > 0 || f.deletions > 0) && (
                    <span className="flex-none font-mono text-[10.5px] text-zinc-500">
                      {f.additions > 0 && (
                        <span className="text-emerald-400">+{f.additions}</span>
                      )}
                      {f.additions > 0 && f.deletions > 0 && " "}
                      {f.deletions > 0 && (
                        <span className="text-red-400">−{f.deletions}</span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Commit + Push — styled like the chat composer: a single pill
          with the textarea on top and buttons in the footer, instead of
          two separate widgets. */}
      {git.hasRepo && (
        <div className="flex-none px-3 pb-3 pt-2">
          <div className="rounded-2xl bg-zinc-800/80 px-3 pt-2 pb-2 ring-1 ring-zinc-700/40 transition-colors focus-within:ring-zinc-600">
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message"
              rows={2}
              className="block w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <button
                onClick={push}
                disabled={busy !== null || !git.remote}
                className="flex h-9 items-center rounded-lg bg-zinc-700/70 px-3.5 text-[13px] text-zinc-100 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  git.remote
                    ? `git push origin (${git.remote.url})`
                    : "Add a remote URL above before pushing"
                }
              >
                {busy === "push" ? "Pushing…" : "Push"}
              </button>
              <button
                onClick={commit}
                disabled={
                  !commitMsg.trim() ||
                  busy !== null ||
                  git.files.length === 0
                }
                className="flex h-9 items-center rounded-lg bg-zinc-100 px-3.5 text-[13px] font-medium text-zinc-900 shadow-sm transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500 disabled:shadow-none"
                title={
                  git.files.length === 0
                    ? "Nothing to commit"
                    : "Stage all changes and commit"
                }
              >
                {busy === "commit" ? "Committing…" : "Commit all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * Inline editor for the origin remote URL. Returns the trimmed value via
 * onSave. Escape cancels, Enter saves, blur cancels — kept tight so it
 * reads like a single-row affordance, not a modal.
 */
function RemoteEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  onSave: (url: string) => void | Promise<void>;
  onCancel: () => void;
}): ReactElement {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="flex flex-1 items-center gap-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const url = value.trim();
            if (url) void onSave(url);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="git@github.com:user/repo.git"
        className="min-w-0 flex-1 rounded bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 ring-1 ring-zinc-700/60 focus:outline-none focus:ring-zinc-500"
      />
      <button
        onClick={() => {
          const url = value.trim();
          if (url) void onSave(url);
        }}
        disabled={busy || !value.trim()}
        className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
      >
        {busy ? "…" : "Save"}
      </button>
      <button
        onClick={onCancel}
        className="rounded px-1 text-zinc-500 hover:text-zinc-200"
        title="Cancel"
      >
        ×
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: string }): ReactElement {
  const { letter, cls } = (() => {
    switch (status) {
      case "modified":
        return { letter: "M", cls: "text-amber-400" };
      case "added":
        return { letter: "A", cls: "text-emerald-400" };
      case "deleted":
        return { letter: "D", cls: "text-red-400" };
      case "renamed":
        return { letter: "R", cls: "text-sky-400" };
      case "copied":
        return { letter: "C", cls: "text-sky-400" };
      case "unmerged":
        return { letter: "!", cls: "text-red-400" };
      case "untracked":
        return { letter: "U", cls: "text-zinc-500" };
      default:
        return { letter: "?", cls: "text-zinc-500" };
    }
  })();
  return (
    <span
      className={`flex h-4 w-4 flex-none items-center justify-center font-mono text-[10px] font-bold ${cls}`}
      title={status}
    >
      {letter}
    </span>
  );
}

/**
 * Full-panel git diff viewer. Loads the unified diff for a single file
 * and renders it. Used as a tab in the main content area, opened from
 * the git panel. The git_file_diff command is called whenever the
 * project + path pair changes; cancelled in-flight if the user opens
 * a different file before the previous load completes.
 */
/**
 * Slim tab strip shown above the main panel when a git-diff file is
 * open. The new left sidebar replaced the multi-tab strip; we still
 * need a way to navigate to / dismiss the open diff.
 */
function DiffTabStrip({
  path,
  selected,
  onSelect,
  onClose,
}: {
  path: string;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="flex flex-none items-center gap-2 border-b border-zinc-700/30 px-4 py-1.5">
      <button
        onClick={onSelect}
        className={`flex flex-none items-center gap-1.5 rounded-md py-1 text-[13px] transition-colors ${
          selected
            ? "bg-[rgb(58_58_64)] px-2.5 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
            : "px-2 text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
        }`}
        title={path}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 flex-none"
        >
          <path d="M3.5 4.5h4" />
          <path d="M5.5 2.5v4" />
          <path d="M9.5 11.5h4" />
        </svg>
        <span className="max-w-[28ch] truncate font-mono">
          {path.split("/").pop() ?? path}
        </span>
      </button>
      <button
        onClick={onClose}
        title="Close diff"
        className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
      >
        ×
      </button>
    </div>
  );
}

function DiffFileView({
  project,
  path,
}: {
  project: Project;
  path: string;
}): ReactElement {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  // Determine "untracked" by querying status — but we can keep it
  // simple: just call the command with untracked=false; the backend
  // returns a useful diff for tracked + staged files. For genuinely
  // untracked files the call errors and we retry with untracked=true.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      try {
        let d: string;
        try {
          d = await invoke<string>("git_file_diff", {
            cwd: project.path,
            path,
            untracked: false,
          });
        } catch {
          // Likely an untracked file (no HEAD baseline). Retry with
          // untracked=true so the backend renders a synthetic added-
          // lines diff from the file's contents.
          d = await invoke<string>("git_file_diff", {
            cwd: project.path,
            path,
            untracked: true,
          });
        }
        if (!cancelled) setText(d);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.path, path]);

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            Diff
          </span>
          <h1
            className="truncate font-mono text-[15px] text-zinc-100"
            title={path}
          >
            {path}
          </h1>
        </div>
        <div className="rounded-lg bg-zinc-900/60 p-4 ring-1 ring-zinc-800/60">
          {loading ? (
            <div className="text-[12px] italic text-zinc-500">Loading diff…</div>
          ) : err ? (
            <div className="text-[12px] text-red-300">{err}</div>
          ) : (
            <DiffView text={text} />
          )}
        </div>
      </div>
    </div>
  );
}

function DiffView({ text }: { text: string }): ReactElement {
  if (!text.trim()) {
    return (
      <div className="text-[11px] italic text-zinc-500">(no changes to show)</div>
    );
  }
  // Color-code unified diff lines. Headers (---, +++, @@) are dim; +
  // green, − red, context default. Keep the rendering simple — pre with
  // per-line spans is plenty for review purposes.
  return (
    <pre className="whitespace-pre font-mono text-[11px] leading-relaxed">
      {text.split("\n").map((line, i) => {
        let cls = "text-zinc-300";
        if (line.startsWith("+++") || line.startsWith("---")) cls = "text-zinc-500";
        else if (line.startsWith("@@")) cls = "text-sky-400";
        else if (line.startsWith("+")) cls = "text-emerald-300";
        else if (line.startsWith("-")) cls = "text-red-300";
        else if (line.startsWith("diff ") || line.startsWith("index "))
          cls = "text-zinc-500";
        return (
          <span key={i} className={`block ${cls}`}>
            {line || "\u00a0"}
          </span>
        );
      })}
    </pre>
  );
}

function FsTaskCard({
  task,
  onRefine,
  onOpen,
}: {
  task: Task;
  onRefine: (id: string, name: string) => void;
  /** Click the title or "Details" button → open the per-task detail view. */
  onOpen: (id: string) => void;
}): ReactElement {
  const name = extractTaskName(task.requirements, task.id);
  const subtasks = useMemo<SpecTask[]>(
    () => parseTasks(task.subtasks),
    [task.subtasks],
  );
  const questions = useMemo<SpecQuestion[]>(
    () => parseQuestions(task.questions),
    [task.questions],
  );
  const total = subtasks.length;
  const done = subtasks.filter((s) => s.done).length;
  const isReadyToMark =
    questions.length === 0 && total > 0 && done === total;
  // Strip the H1 so the preview shows the body, not the title.
  const previewSource = task.requirements.replace(/^#\s+.*$/m, "").trim();
  const preview = previewMarkdown(previewSource);
  const truncated =
    previewSource.length > 0 && preview.length < previewSource.length;
  const [expanded, setExpanded] = useState(false);

  // "Copy hand-off prompt" — produces a paragraph the user pastes into
  // their editor (VSCode/Cursor/Claude Code). The agent there reads
  // the spec files and implements. Outset stays the planning surface.
  const [copied, setCopied] = useState(false);
  function copyHandoff(): void {
    const handoff = [
      `Working on ${task.id} (${name}).`,
      "",
      "Read these to understand the task:",
      `- .spec/tasks/${task.id}/requirements.md`,
      `- .spec/tasks/${task.id}/subtasks.md`,
      "- .spec/codebase/architecture.md",
      "- any .spec/codebase/features/FEAT-*.md the requirements references",
      "",
      "Then implement the unchecked subtasks. As you finish each, update",
      `.spec/tasks/${task.id}/subtasks.md to flip its checkbox to [x].`,
      "Don't modify .spec/product/ or .spec/codebase/ — those get folded",
      "later via the spec maintainer in Outset.",
    ].join("\n");
    void navigator.clipboard
      .writeText(handoff)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {
        // Clipboard can fail in obscure cases (focus, permissions);
        // fall back silently — the user can copy from the title attr.
      });
  }
  const canHandoff = questions.length === 0 && total > 0 && !isReadyToMark;
  return (
    <div
      className={`group flex flex-col gap-3 rounded-xl bg-zinc-800/40 p-4 ring-1 transition-colors hover:bg-zinc-800/60 ${
        isReadyToMark ? "ring-emerald-800/60" : "ring-zinc-800/60"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <button
          onClick={() => onOpen(task.id)}
          className="min-w-0 flex-1 text-left transition-opacity hover:opacity-80"
          title="Open task details"
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-zinc-500">
              {task.id}
            </span>
            {isReadyToMark && (
              <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                Ready to fold
              </span>
            )}
          </div>
          <h3 className="mt-0.5 truncate text-[16px] font-semibold text-zinc-100">
            {name}
          </h3>
        </button>
        <div className="flex-none text-[11px] text-zinc-500">
          {questions.length > 0 && (
            <span>
              {questions.length} q{questions.length === 1 ? "" : "s"}
            </span>
          )}
          {questions.length > 0 && total > 0 && <span> · </span>}
          {total > 0 && (
            <span>
              {done}/{total} subtasks
            </span>
          )}
        </div>
      </div>
      {previewSource.length > 0 && (
        <div className="text-[13.5px] leading-relaxed text-zinc-300">
          {expanded ? (
            <Markdown text={previewSource} />
          ) : (
            <>
              <div className="whitespace-pre-wrap">{preview}</div>
              {truncated && (
                <button
                  onClick={() => setExpanded(true)}
                  className="mt-1 text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Show more →
                </button>
              )}
            </>
          )}
          {expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="mt-1 text-xs text-zinc-500 hover:text-zinc-300"
            >
              ← Collapse
            </button>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        {canHandoff && (
          <button
            onClick={copyHandoff}
            className="flex-none rounded-md bg-zinc-800/70 px-2.5 py-1 text-[12.5px] text-zinc-200 ring-1 ring-zinc-700/60 transition-colors hover:bg-zinc-800"
            title="Copy a prompt to paste into your editor (VSCode, Cursor, Claude Code, etc.). The agent there reads the spec and implements."
          >
            {copied ? "Copied!" : "Copy prompt"}
          </button>
        )}
        <button
          onClick={() => onRefine(task.id, name)}
          className={`flex-none rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${
            isReadyToMark
              ? "bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60"
              : "bg-zinc-700/60 text-zinc-200 hover:bg-zinc-700"
          }`}
          title={
            isReadyToMark
              ? "Open the project chat to fold this task into product/codebase, then mark complete."
              : "Refine this task in the project chat — ask scoping questions, list subtasks."
          }
        >
          {isReadyToMark ? "Fold →" : "Refine →"}
        </button>
      </div>
    </div>
  );
}

/**
 * Per-task detail view. Shown when the user clicks a task title (in the
 * sidebar list or on the Tasks card). Renders the three files under
 * `.spec/tasks/TASK-NNN/` that the agent maintains:
 *   - requirements.md  (rendered as markdown)
 *   - questions.md     (numbered open questions)
 *   - subtasks.md      (checkbox list, read-only — checkboxes flip when
 *                      the user's editor agent updates the file on disk;
 *                      this view re-reads the file via list_tasks polling)
 *
 * The card already has Refine / Copy prompt / Fold actions; this view
 * mirrors them so the user doesn't have to bounce back to the list to
 * act on the open task.
 */
function TaskDetailView({
  project,
  task,
  taskIdSelected,
  onBack,
  onRefine,
}: {
  project: Project;
  /** Resolved task entry; null when the id no longer matches any task on disk. */
  task: Task | null;
  /** The id we tried to open, even when the task object is null. */
  taskIdSelected: string | null;
  onBack: () => void;
  onRefine: (id: string, name: string) => void;
}): ReactElement {
  if (!task) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-8">
        <button
          onClick={onBack}
          className="mb-4 text-[12.5px] text-zinc-500 hover:text-zinc-300"
        >
          ← All tasks
        </button>
        <div className="rounded-xl bg-zinc-800/30 px-4 py-12 text-center text-sm text-zinc-500 ring-1 ring-zinc-800/60">
          {taskIdSelected ? (
            <>
              Task <span className="font-mono">{taskIdSelected}</span>{" "}
              wasn't found on disk. It may have been folded and removed.
            </>
          ) : (
            "Task not found."
          )}
        </div>
      </div>
    );
  }
  // Bind to a non-null local so closures (copyHandoff, the action
  // buttons below) don't trip on TS narrowing through the early-return.
  const t: Task = task;
  const name = extractTaskName(t.requirements, t.id);
  const subtasks = parseTasks(t.subtasks);
  const questions = parseQuestions(t.questions);
  const total = subtasks.length;
  const done = subtasks.filter((s) => s.done).length;
  const isReadyToMark =
    questions.length === 0 && total > 0 && done === total;
  const canHandoff = questions.length === 0 && total > 0 && !isReadyToMark;

  function copyHandoff(): void {
    const handoff = [
      `Working on ${t.id} (${name}).`,
      "",
      "Read these to understand the task:",
      `- .spec/tasks/${t.id}/requirements.md`,
      `- .spec/tasks/${t.id}/subtasks.md`,
      "- .spec/codebase/architecture.md",
      "- any .spec/codebase/features/FEAT-*.md the requirements references",
      "",
      "Then implement the unchecked subtasks. As you finish each, update",
      `.spec/tasks/${t.id}/subtasks.md to flip its checkbox to [x].`,
      "Don't modify .spec/product/ or .spec/codebase/ — those get folded",
      "later via the spec maintainer in Outset.",
    ].join("\n");
    void navigator.clipboard.writeText(handoff).catch(() => {
      // Clipboard can fail silently — the user can copy from the
      // requirements pane instead.
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <button
        onClick={onBack}
        className="mb-4 text-[12.5px] text-zinc-500 hover:text-zinc-300"
      >
        ← All tasks
      </button>
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
            <span>{project.name}</span>
            <span className="text-zinc-600">·</span>
            <span className="font-mono normal-case tracking-normal text-zinc-400">
              {t.id}
            </span>
            {isReadyToMark && (
              <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                Ready to fold
              </span>
            )}
          </div>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-100">
            {name}
          </h1>
          <div className="mt-1 text-[12px] text-zinc-500">
            {questions.length > 0 && (
              <span>
                {questions.length} open question
                {questions.length === 1 ? "" : "s"}
              </span>
            )}
            {questions.length > 0 && total > 0 && <span> · </span>}
            {total > 0 && (
              <span>
                {done}/{total} subtasks
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {canHandoff && (
            <button
              onClick={copyHandoff}
              className="rounded-md bg-zinc-800/70 px-2.5 py-1 text-[12.5px] text-zinc-200 ring-1 ring-zinc-700/60 transition-colors hover:bg-zinc-800"
              title="Copy a prompt to paste into your editor."
            >
              Copy prompt
            </button>
          )}
          <button
            onClick={() => onRefine(t.id, name)}
            className={`rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${
              isReadyToMark
                ? "bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60"
                : "bg-zinc-700/60 text-zinc-200 hover:bg-zinc-700"
            }`}
          >
            {isReadyToMark ? "Fold →" : "Refine →"}
          </button>
        </div>
      </div>

      {/* Requirements */}
      <section className="mb-6">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Requirements
        </h2>
        <div className="rounded-xl bg-zinc-800/30 px-5 py-4 ring-1 ring-zinc-800/60">
          {t.requirements.trim().length === 0 ? (
            <div className="text-[13px] italic text-zinc-500">
              No requirements written yet. Click "Refine →" to scope them
              with the agent.
            </div>
          ) : (
            <Markdown text={t.requirements} variant="doc" />
          )}
        </div>
      </section>

      {/* Subtasks */}
      <section className="mb-6">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Subtasks {total > 0 ? `(${done}/${total})` : ""}
        </h2>
        <div className="rounded-xl bg-zinc-800/30 px-5 py-4 ring-1 ring-zinc-800/60">
          {subtasks.length === 0 ? (
            <div className="text-[13px] italic text-zinc-500">
              Subtasks aren't broken down yet. Open the chat and ask the
              agent to propose a checklist.
            </div>
          ) : (
            // Body font-size matches the markdown body in the
            // Requirements section (16px ambient from <body>) so the
            // two reading lanes feel like one document.
            <ul className="font-serif-prose flex flex-col gap-2">
              {subtasks.map((s) => (
                <li
                  key={s.id}
                  className="flex items-start gap-2.5 leading-relaxed"
                >
                  <span
                    aria-hidden
                    className={`mt-1 flex h-[18px] w-[18px] flex-none items-center justify-center rounded border text-[11px] ${
                      s.done
                        ? "border-emerald-700/70 bg-emerald-900/30 text-emerald-300"
                        : "border-zinc-700 bg-zinc-900/40 text-transparent"
                    }`}
                  >
                    {s.done ? "✓" : ""}
                  </span>
                  {/* `min-w-0 flex-1` lets long lines wrap inside the
                      flex row instead of overflowing or being clipped;
                      `whitespace-pre-wrap` preserves intentional line
                      breaks the agent might write into the bullet. */}
                  <span
                    className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
                      s.done
                        ? "text-zinc-500 line-through decoration-zinc-700"
                        : "text-zinc-200"
                    }`}
                  >
                    {s.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-1 px-1 text-[11px] text-zinc-600">
          Checkboxes are read-only here; your editor's agent flips them
          in <span className="font-mono">subtasks.md</span> as it works.
        </div>
      </section>

      {/* Open questions */}
      {questions.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Open questions ({questions.length})
          </h2>
          <div className="rounded-xl bg-zinc-800/30 px-5 py-4 ring-1 ring-zinc-800/60">
            <ol className="font-serif-prose flex list-decimal flex-col gap-2 pl-5 leading-relaxed text-zinc-200 marker:text-zinc-500">
              {questions.map((q) => (
                <li key={q.id}>
                  {q.section && (
                    <span className="mr-2 rounded bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
                      {q.section}
                    </span>
                  )}
                  {q.text}
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- shared sub-components for the project views ----------

function ViewHeader({
  project,
  sectionLabel,
  action,
}: {
  project: Project;
  sectionLabel: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="mb-5 flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">
          {project.name}
        </div>
        <h1 className="truncate text-2xl font-semibold tracking-tight text-zinc-100">
          {sectionLabel}
        </h1>
      </div>
      {action && <div className="flex-none">{action}</div>}
    </div>
  );
}

function SpecTreeItem({
  icon,
  label,
  subtitle,
  active,
  empty,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  subtitle?: string;
  active: boolean;
  empty?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <li>
      <button
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
          active
            ? "bg-[rgb(58_58_64)] text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
            : empty
              ? "text-zinc-600 hover:bg-zinc-800/50 hover:text-zinc-300"
              : "text-zinc-300 hover:bg-zinc-800/50"
        }`}
      >
        {icon && <span className="flex-none text-zinc-500">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {subtitle && (
            <span className="block truncate font-mono text-[10px] text-zinc-500">
              {subtitle}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function SpecContent({ text }: { text: string }): ReactElement {
  return (
    <div className="text-[16px] leading-relaxed text-zinc-200">
      <Markdown text={text} variant="doc" />
    </div>
  );
}

function SpecEmpty({ text }: { text: string }): ReactElement {
  return (
    <div className="rounded-xl bg-zinc-800/30 px-4 py-8 text-center text-sm text-zinc-500 ring-1 ring-zinc-800/60">
      {text}
    </div>
  );
}

function extractFeatureName(f: Feature): string {
  const m = /^#\s+(.*\S)\s*$/m.exec(f.content);
  return m?.[1]?.trim() ?? f.id;
}

/**
 * Render-segment unit. The chat groups consecutive tool_use/tool_result
 * items into a single collapsed line — they're noise next to the agent's
 * actual prose and should compact between text turns.
 */
type RenderSegment =
  | { kind: "tool_group"; items: ChatItem[] }
  | { kind: "single"; item: ChatItem };

function groupChatItems(items: ChatItem[]): RenderSegment[] {
  const segments: RenderSegment[] = [];
  let buf: ChatItem[] = [];
  function flush(): void {
    if (buf.length > 0) {
      segments.push({ kind: "tool_group", items: buf });
      buf = [];
    }
  }
  for (const it of items) {
    if (it.kind === "tool_use" || it.kind === "tool_result") {
      buf.push(it);
    } else {
      flush();
      segments.push({ kind: "single", item: it });
    }
  }
  flush();
  return segments;
}

/**
 * Verb/object shape for a tool. We aggregate uses by the (verb, obj)
 * pair to produce summaries like "Edited 2 files, read a file".
 */
function toolVerbObject(name: string): { verb: string; obj: string | null } {
  switch (name) {
    case "Read":
      return { verb: "read", obj: "file" };
    case "Write":
      return { verb: "wrote", obj: "file" };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "edited", obj: "file" };
    case "Glob":
      return { verb: "searched files", obj: null };
    case "Grep":
      return { verb: "searched code", obj: null };
    case "LS":
      return { verb: "listed", obj: "directory" };
    case "Bash":
      return { verb: "ran", obj: "command" };
    case "TodoWrite":
      return { verb: "updated todos", obj: null };
    case "WebFetch":
      return { verb: "fetched", obj: "page" };
    case "Task":
      return { verb: "ran", obj: "subagent" };
    default:
      return { verb: "used", obj: name };
  }
}

function pluralizeObj(obj: string, n: number): string {
  if (n === 1) return `a ${obj}`;
  if (obj === "directory") return `${n} directories`;
  return `${n} ${obj}s`;
}

function summarizeToolGroup(items: ChatItem[]): string {
  type Bucket = { verb: string; obj: string | null; count: number };
  const buckets: Bucket[] = [];
  for (const it of items) {
    if (it.kind !== "tool_use") continue;
    const vo = toolVerbObject(it.name);
    const existing = buckets.find(
      (b) => b.verb === vo.verb && b.obj === vo.obj,
    );
    if (existing) existing.count += 1;
    else buckets.push({ ...vo, count: 1 });
  }
  if (buckets.length === 0) return "Tool activity";
  const parts = buckets.map((b, i) => {
    const verb = i === 0 ? b.verb.charAt(0).toUpperCase() + b.verb.slice(1) : b.verb;
    if (b.obj === null) return b.count > 1 ? `${verb} ×${b.count}` : verb;
    return `${verb} ${pluralizeObj(b.obj, b.count)}`;
  });
  return parts.join(", ");
}

function ToolGroupView({ items }: { items: ChatItem[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolGroup(items);
  // Pair each tool_use with its tool_result by toolUseId for display.
  const resultsByUseId = new Map<
    string,
    Extract<ChatItem, { kind: "tool_result" }>
  >();
  for (const it of items) {
    if (it.kind === "tool_result") resultsByUseId.set(it.toolUseId, it);
  }
  const uses = items.filter(
    (it): it is Extract<ChatItem, { kind: "tool_use" }> =>
      it.kind === "tool_use",
  );
  const hasError = items.some((it) => it.kind === "tool_result" && it.isError);
  return (
    // Extra top/bottom margin so a tool group reads as a clear beat
    // between text turns instead of crowding the message above and
    // below it.
    <div className="my-2 self-stretch">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`group flex items-center gap-1.5 text-xs ${
          hasError
            ? "text-red-300/80 hover:text-red-200"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        <span
          className={`inline-block w-3 select-none transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          ›
        </span>
        <span>{summary}</span>
        {hasError && <span className="text-red-300">(error)</span>}
      </button>
      {open && (
        <div className="mt-2 ml-4 flex flex-col gap-3 border-l border-zinc-800/60 pl-3">
          {uses.map((use) => (
            <ToolDetail
              key={use.id}
              use={use}
              result={resultsByUseId.get(use.toolUseId) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolDetail({
  use,
  result,
}: {
  use: Extract<ChatItem, { kind: "tool_use" }>;
  result: Extract<ChatItem, { kind: "tool_result" }> | null;
}): ReactElement {
  const text = result?.text ?? "";
  const firstLine = text.split("\n")[0] ?? "";
  const preview =
    firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
  const multiline = text.includes("\n") || text.length > 100;
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none flex-col gap-1 font-mono text-[11px]">
        <span className="flex items-baseline gap-2">
          <span className="text-zinc-500 group-open:rotate-90 transition-transform select-none">
            ▸
          </span>
          <span className="min-w-0 flex-1 break-words text-zinc-300">
            {summarizeToolUse(use.name, use.input)}
          </span>
        </span>
        {result && (
          <span
            className={`ml-5 block truncate ${
              result.isError ? "text-red-300/80" : "text-zinc-500"
            }`}
          >
            {result.isError ? "✗ " : "↳ "}
            {preview || "(empty)"}
          </span>
        )}
      </summary>
      <div className="ml-5 mt-1 flex flex-col gap-1">
        <pre className="whitespace-pre-wrap rounded-md bg-zinc-900/40 px-2 py-1.5 text-[10.5px] text-zinc-500">
          {safeStringify(use.input)}
        </pre>
        {result && multiline && (
          <pre
            className={`max-h-60 overflow-auto whitespace-pre-wrap rounded-md px-2 py-1.5 text-[10.5px] ${
              result.isError ? "bg-red-950/30 text-red-200" : "bg-zinc-900/40 text-zinc-400"
            }`}
          >
            {text}
          </pre>
        )}
      </div>
    </details>
  );
}

function ItemView({ item }: { item: ChatItem }): ReactElement | null {
  switch (item.kind) {
    case "user":
      return (
        <Bubble align="right" tone="user">
          {item.text}
        </Bubble>
      );
    case "assistant_text":
      return (
        <Bubble align="left" tone="assistant">
          <Markdown text={item.text} />
        </Bubble>
      );
    case "thinking":
      return (
        <details className="self-start text-xs text-zinc-500">
          <summary className="cursor-pointer select-none">thinking…</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">{item.text}</pre>
        </details>
      );
    case "tool_use":
    case "tool_result":
      // Handled by ToolGroupView; ItemView never sees these in the new
      // render path. Keep the cases for type exhaustiveness.
      return null;
    case "system":
      return (
        <div className="self-center text-[11px] uppercase tracking-wide text-zinc-600">
          {item.subtype}
          {item.details ? ` · ${item.details}` : ""}
        </div>
      );
    case "result": {
      const cost =
        typeof item.costUsd === "number"
          ? `~$${item.costUsd.toFixed(4)}`
          : "—";
      const dur =
        typeof item.durationMs === "number"
          ? `${(item.durationMs / 1000).toFixed(1)}s`
          : "—";
      return (
        <div className="self-center text-[11px] text-zinc-500">
          done · {item.subtype} · turns: {item.numTurns ?? "?"} · {dur} · {cost}
        </div>
      );
    }
    case "error":
      return (
        <div className="self-stretch rounded-md border border-red-800/50 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          {item.message}
        </div>
      );
  }
}

/**
 * Chat bubble. The assistant gets bare text on the canvas (no border, no
 * background) so the prose feels like a document; only user messages
 * are pilled with a subtle bg to mark whose turn it is. This matches the
 * Cowork target — the visible weight is on the text, not the chrome.
 */
function Bubble({
  align,
  tone,
  children,
}: {
  align: "left" | "right";
  tone: "user" | "assistant";
  children: ReactNode;
}): ReactElement {
  if (tone === "assistant") {
    // No whitespace-pre-wrap here — Markdown renders structured HTML
    // (<p>, <ul>, <h*>) and handles its own block spacing. With
    // pre-wrap the trailing newlines often present in agent text
    // chunks render as visible empty space between successive bubbles.
    return (
      <div className="self-stretch text-[16px] leading-relaxed text-zinc-100">
        {children}
      </div>
    );
  }
  const alignCls = align === "right" ? "self-end" : "self-start";
  return (
    <div
      className={`font-serif-prose max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[rgb(58_58_64)] px-4 py-2.5 text-[16px] leading-relaxed text-zinc-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)] ring-1 ring-zinc-600/50 ${alignCls}`}
    >
      {children}
    </div>
  );
}

/**
 * Color swatch with click-to-open popover. Used in both the sidebar (small)
 * and the header (slightly larger). Manages its own open/close state and
 * dismisses on outside click via a [data-color-picker] guard.
 */
function ColorDot({
  color,
  onPick,
  size = "sm",
  align = "left",
}: {
  color: ProjectColor;
  onPick: (c: ProjectColor) => void;
  size?: "sm" | "md";
  align?: "left" | "right";
}): ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-color-picker]")) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const dotCls = size === "md" ? "h-3 w-3" : "h-2.5 w-2.5";
  const alignCls = align === "right" ? "right-0" : "left-0";
  return (
    <span data-color-picker className="relative inline-flex">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`${dotCls} rounded-full ${PROJECT_COLOR_DOT_CLS[color]} ring-1 ring-black/30 hover:ring-zinc-400`}
        title="Change color"
      >
        <span className="sr-only">Change color</span>
      </button>
      {open && (
        <div
          className={`absolute ${alignCls} top-full z-20 mt-1 flex gap-1 rounded-md border border-zinc-700 bg-zinc-900 p-1.5 shadow-xl`}
        >
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              onClick={(e) => {
                e.stopPropagation();
                onPick(c);
                setOpen(false);
              }}
              className={`h-4 w-4 rounded-full ${PROJECT_COLOR_DOT_CLS[c]} ring-1 ring-black/30 hover:scale-110 ${
                c === color ? "ring-2 ring-zinc-200" : ""
              }`}
              title={c}
            />
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * Inline rename: shows `value` as text; double-click to enter an editor.
 * Enter or blur commits (if non-empty); Escape cancels.
 */
function RenameableLabel({
  value,
  onRename,
  className,
  inputClassName,
  title,
  editTrigger,
}: {
  value: string;
  onRename: (next: string) => void;
  className?: string;
  inputClassName?: string;
  title?: string;
  /**
   * Optional. When this number changes, the label enters editing mode.
   * Used by parents (e.g. the project Settings dropdown) to trigger
   * inline rename programmatically — `window.prompt` is suppressed in
   * Tauri's WebView, so the dropdown can't ask for the new name itself.
   */
  editTrigger?: number;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  // Programmatic entry into editing mode. Skip the initial mount so we
  // don't auto-edit on first render — only fire when the trigger value
  // actually changes after mount.
  const lastTriggerRef = useRef<number | undefined>(editTrigger);
  useEffect(() => {
    if (editTrigger === undefined) return;
    if (lastTriggerRef.current === editTrigger) return;
    lastTriggerRef.current = editTrigger;
    setDraft(value);
    setEditing(true);
  }, [editTrigger, value]);
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();
          setEditing(false);
          if (trimmed && trimmed !== value) onRename(trimmed);
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className={
          inputClassName ??
          "rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        }
      />
    );
  }
  return (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={className}
      title={title ?? "Double-click to rename"}
    >
      {value}
    </span>
  );
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 800 ? s.slice(0, 800) + "…" : s;
  } catch {
    return String(v);
  }
}

/**
 * Compact one-line summary for a tool call. Shown collapsed by default in the
 * chat; user expands to see full input. Covers Claude Code's standard tool
 * vocabulary; falls back to the bare name for unknown tools.
 */
function summarizeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path =
    typeof i.file_path === "string"
      ? i.file_path
      : typeof i.path === "string"
        ? i.path
        : undefined;
  switch (name) {
    case "Read":
      return path ? `Read ${shortPath(path)}` : "Read";
    case "Write":
      return path ? `Write ${shortPath(path)}` : "Write";
    case "Edit":
      return path ? `Edit ${shortPath(path)}` : "Edit";
    case "MultiEdit":
      return path ? `MultiEdit ${shortPath(path)}` : "MultiEdit";
    case "NotebookEdit":
      return path ? `NotebookEdit ${shortPath(path)}` : "NotebookEdit";
    case "Glob":
      return `Glob \`${i.pattern ?? ""}\``;
    case "Grep": {
      const p = String(i.pattern ?? "");
      const g = (i.glob ?? i.path ?? "") as string;
      return g ? `Grep \`${p}\` in ${g}` : `Grep \`${p}\``;
    }
    case "Bash": {
      const c = String(i.command ?? "");
      return `$ ${c.length > 70 ? c.slice(0, 70) + "…" : c}`;
    }
    case "LS":
      return path ? `List ${shortPath(path)}` : "List";
    case "TodoWrite":
      return "Update todos";
    case "WebFetch":
      return `Fetch ${String(i.url ?? "")}`;
    case "WebSearch":
      return `Search "${String(i.query ?? "")}"`;
    case "Task":
      return `Spawn agent: ${String(i.description ?? i.subagent_type ?? "")}`;
    default:
      return name;
  }
}

function shortPath(p: string): string {
  return p.length <= 60 ? p : "…" + p.slice(-57);
}

function BusyIndicator(): ReactElement {
  return (
    <div className="self-start flex items-center gap-2 px-1 text-xs text-zinc-400">
      <span className="relative inline-flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
      </span>
      Claude is working…
    </div>
  );
}

/**
 * Permission-request modal. Renders when the SDK's canUseTool callback fires
 * (via the sidecar's permission_request event). One request shown at a time;
 * additional requests stack up via the queue and surface in order.
 */
function PermissionModal({
  request,
  queueLength,
  onResolve,
}: {
  request: (PermissionRequestPayload & { sessionId: string }) | null;
  queueLength: number;
  onResolve: (decision: "allow" | "deny") => void;
}): ReactElement | null {
  useEffect(() => {
    if (!request) return;
    function onKey(e: KeyboardEvent) {
      // Only handle when the modal is the topmost overlay. Confirm modal has
      // its own listener, but we render PermissionModal AFTER ConfirmModal so
      // its z-index and capture should be on top when both are present.
      if (e.key === "Enter") {
        e.preventDefault();
        onResolve("allow");
      } else if (e.key === "Escape") {
        e.preventDefault();
        onResolve("deny");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, onResolve]);

  if (!request) return null;
  const summary = summarizeToolUse(request.tool, request.input);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[480px] max-w-[92%] rounded-md border border-zinc-700 bg-zinc-900 p-4 shadow-2xl">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-sm font-semibold text-zinc-100">
            {request.title ?? "Allow tool use?"}
          </div>
          {queueLength > 1 && (
            <div className="text-[11px] text-zinc-500">
              {queueLength - 1} more queued
            </div>
          )}
        </div>
        {request.description && (
          <div className="mb-3 text-xs leading-relaxed text-zinc-400">
            {request.description}
          </div>
        )}
        <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200">
          <div className="text-zinc-500">{request.tool}</div>
          <div className="mt-0.5">{summary}</div>
          <details className="mt-1 text-[11px] text-zinc-500">
            <summary className="cursor-pointer">full input</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-zinc-400">
              {safeStringify(request.input)}
            </pre>
          </details>
        </div>
        {request.blocked_path && (
          <div className="mb-3 text-[11px] text-zinc-500">
            <span className="text-zinc-600">path:</span> {request.blocked_path}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => onResolve("deny")}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Deny
            <span className="ml-1 text-[10px] text-zinc-500">Esc</span>
          </button>
          <button
            onClick={() => onResolve("allow")}
            autoFocus
            className="rounded-md border border-emerald-700 bg-emerald-800 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-700"
          >
            Allow
            <span className="ml-1 text-[10px] text-emerald-200/70">⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * In-app confirm modal. Tauri's WebView suppresses window.confirm, so any
 * destructive action goes through this instead.
 */
function ConfirmModal({
  req,
  onClose,
}: {
  req: ConfirmRequest | null;
  onClose: () => void;
}): ReactElement | null {
  useEffect(() => {
    if (!req) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        req?.onConfirm();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, onClose]);

  if (!req) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[92%] rounded-md border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-sm font-semibold text-zinc-100">{req.title}</div>
        <div className="mb-4 text-xs leading-relaxed text-zinc-400">{req.body}</div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              req.onConfirm();
              onClose();
            }}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
              req.destructive
                ? "border-red-700 bg-red-800 text-red-50 hover:bg-red-700"
                : "border-zinc-700 bg-zinc-100 text-zinc-900 hover:bg-white"
            }`}
            autoFocus
          >
            {req.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
