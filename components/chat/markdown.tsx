import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/chat/code-block";

/**
 * react-markdown renders to real React elements rather than injecting
 * HTML strings, so model output can never execute as script — there is
 * no dangerouslySetInnerHTML anywhere in this path.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const isBlock = /language-(\w+)/.test(className ?? "");
            if (isBlock) {
              return (
                <CodeBlock className={className}>{String(children).replace(/\n$/, "")}</CodeBlock>
              );
            }
            return (
              <code className="rounded bg-paper px-1 py-0.5 font-mono text-[0.85em]" {...props}>
                {children}
              </code>
            );
          },
          // Wide tables scroll inside their own container instead of stretching the bubble/page.
          table({ children }) {
            return (
              <div className="overflow-x-auto scrollbar-thin">
                <table>{children}</table>
              </div>
            );
          },
          a({ children, ...props }) {
            return (
              <a
                {...props}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
