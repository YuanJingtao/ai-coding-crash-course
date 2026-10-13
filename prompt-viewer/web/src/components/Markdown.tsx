import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface Props {
  children: string;
  /** 附加到容器的类名 */
  className?: string;
}

/**
 * 统一的 Markdown 渲染器。
 * 内容里的 Echo Tag（如 <EXTREMELY-IMPORTANT>）会被 react-markdown 当作未知 HTML
 * 处理——默认不渲染 HTML，因此它们会以纯文本形式安全展示，符合"按字面渲染"的领域约定。
 */
export const Markdown = memo(function Markdown({ children, className = "" }: Props) {
  return (
    <div className={`md-body prose prose-invert max-w-none ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
