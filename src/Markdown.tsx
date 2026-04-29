import type { ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for assistant chat bubbles.
 *
 * We map every element to a Tailwind-styled wrapper rather than using the
 * `@tailwindcss/typography` plugin's `prose` classes. The reason: chat
 * bubbles already have their own width, padding, and color treatment, and
 * `prose` aggressively overrides those. Per-element control keeps the bubble
 * intact while still rendering rich markdown.
 *
 * Supported via remark-gfm: tables, strikethrough, task lists, autolinks.
 */
export function Markdown({
  text,
  variant = "compact",
}: {
  text: string;
  /**
   * - "compact" (default): tight headings/paragraphs, used inside chat
   *   bubbles where the bubble already provides the rhythm.
   * - "doc": full-document treatment with clear heading sizes and
   *   generous top-spacing — for product/codebase markdown viewers.
   */
  variant?: "compact" | "doc";
}): ReactElement {
  const isDoc = variant === "doc";
  return (
    <div className="font-serif-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
        // Headings — sizes step up clearly in doc mode so they read as
        // landmarks, with extra top-margin for breathing room between
        // sections.
        h1: ({ children }) => (
          <h1
            className={
              isDoc
                ? "mb-3 mt-8 text-[26px] font-semibold leading-tight tracking-tight first:mt-0"
                : "mb-1 mt-2 text-base font-semibold first:mt-0"
            }
          >
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2
            className={
              isDoc
                ? "mb-2 mt-7 text-[20px] font-semibold leading-tight tracking-tight first:mt-0"
                : "mb-1 mt-2 text-sm font-semibold first:mt-0"
            }
          >
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3
            className={
              isDoc
                ? "mb-2 mt-6 text-[17px] font-semibold leading-snug first:mt-0"
                : "mb-1 mt-2 text-sm font-semibold first:mt-0"
            }
          >
            {children}
          </h3>
        ),
        h4: ({ children }) => (
          <h4
            className={
              isDoc
                ? "mb-1.5 mt-5 text-[15px] font-semibold leading-snug first:mt-0"
                : "mb-1 mt-2 text-xs font-semibold uppercase tracking-wide first:mt-0"
            }
          >
            {children}
          </h4>
        ),
        // Paragraphs — bubbles get tight spacing; doc gets comfortable
        // breathing room. Inside lists we kill margins (see ul/ol).
        p: ({ children }) => (
          <p
            className={
              isDoc
                ? "my-3 leading-relaxed first:mt-0 last:mb-0"
                : "my-0.5 first:mt-0 last:mb-0"
            }
          >
            {children}
          </p>
        ),
        // Emphasis.
        strong: ({ children }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        del: ({ children }) => (
          <del className="text-zinc-500 line-through">{children}</del>
        ),
        // Lists. The `[&_p]:my-0` is critical: react-markdown wraps each
        // <li>'s content in a <p>, and our paragraph margin would otherwise
        // double-apply between items.
        ul: ({ children }) => (
          <ul className="my-1 list-disc pl-5 first:mt-0 last:mb-0 [&_p]:my-0">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="my-1 list-decimal pl-5 first:mt-0 last:mb-0 [&_p]:my-0">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="leading-snug">{children}</li>,
        // Quote.
        blockquote: ({ children }) => (
          <blockquote className="my-1 border-l-2 border-zinc-700 pl-3 italic text-zinc-400">
            {children}
          </blockquote>
        ),
        // Links.
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 underline-offset-2 hover:underline"
          >
            {children}
          </a>
        ),
        // Code: inline vs. block. With react-markdown 9, inline is detected by
        // the absence of `\n` plus the `inline` flag on older versions; the
        // safer check is on whether the parent is `<pre>` (block) — but the
        // simplest cross-version way is to check if children contains a
        // newline OR if the className indicates a language.
        code: ({ className, children, ...rest }) => {
          const text = String(children ?? "");
          const isBlock =
            text.includes("\n") || /\blanguage-/.test(className ?? "");
          if (isBlock) {
            return (
              <pre className="my-2 overflow-x-auto rounded bg-zinc-950/70 p-2 font-mono text-xs">
                <code {...rest}>{text.replace(/\n$/, "")}</code>
              </pre>
            );
          }
          return (
            <code
              className="rounded bg-[rgb(58_58_64)] px-1.5 py-0.5 font-mono text-[0.85em] text-amber-200 ring-1 ring-zinc-600/70"
              {...rest}
            >
              {children}
            </code>
          );
        },
        // Horizontal rule.
        hr: () => <hr className="my-3 border-zinc-700" />,
        // Tables (gfm).
        table: ({ children }: { children?: ReactNode }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="border-b border-zinc-700 text-left">{children}</thead>
        ),
        th: ({ children }) => (
          <th className="px-2 py-1 font-semibold">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border-b border-zinc-800 px-2 py-1 align-top">
            {children}
          </td>
        ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
