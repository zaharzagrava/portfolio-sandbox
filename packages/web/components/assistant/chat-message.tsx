import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

interface ToolCall {
  name: string;
  status: 'pending' | 'success' | 'error';
}

interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolCall[];
}

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isAssistant = message.role === 'assistant';

  return (
    <div className={cn("flex w-full gap-3", isAssistant ? "justify-start" : "justify-end")}>
      {isAssistant && (
        <Avatar className="h-8 w-8 shrink-0 mt-1">
          <AvatarFallback className="bg-primary/10 text-primary">
            <Bot className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
      
      <div className={cn("flex flex-col gap-2 max-w-[85%]", isAssistant ? "items-start" : "items-end")}>
        {message.tools && message.tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1 mb-1">
            {message.tools.map((tool, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80"
              >
                {tool.status === 'pending' && <CircleDashed className="h-3 w-3 animate-spin text-muted-foreground" />}
                {tool.status === 'success' && <CheckCircle2 className="h-3 w-3 text-green-500" />}
                {tool.status === 'error' && <XCircle className="h-3 w-3 text-destructive" />}
                <span className="capitalize">{tool.name.replace(/_/g, ' ')}</span>
              </span>
            ))}
          </div>
        )}
        
        {message.content && (
          <div
            className={cn(
              "rounded-lg px-4 py-2.5 text-sm",
              isAssistant 
                ? "bg-muted text-foreground" 
                : "bg-primary text-primary-foreground"
            )}
          >
            <div className="prose prose-sm dark:prose-invert break-words max-w-none" data-testid={isAssistant ? 'assistant-message' : 'user-message'}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>

      {!isAssistant && (
        <Avatar className="h-8 w-8 shrink-0 mt-1">
          <AvatarFallback className="bg-primary text-primary-foreground">
            <User className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}
