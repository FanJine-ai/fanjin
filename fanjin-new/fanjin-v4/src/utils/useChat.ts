// useChat.ts — migrated from fanjin-web Vue composable → React hook.
// Vue reactivity (ref/computed/watch/onMounted/onUnmounted) replaced with React hooks.
// Types from @tdesign-vue-next/chat replaced with local definitions.
import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import io from "socket.io-client";
type Socket = ReturnType<typeof io>;

// ── Types (replacing @tdesign-vue-next/chat imports) ────────────────────────

export type ChatMessageStatus = "pending" | "streaming" | "complete" | "error" | "stop";

export interface ChatContentItem {
  id?: string;
  type: string;
  data: any;
  status: ChatMessageStatus;
  ext?: Record<string, any>;
}

export interface UserMessage {
  id: string;
  role: "user";
  name?: string;
  status: ChatMessageStatus;
  datetime: string;
  content: ChatContentItem[];
  ext?: Record<string, any>;
}

export interface AIMessage {
  id: string;
  role: "assistant";
  name?: string;
  status: ChatMessageStatus;
  datetime: string;
  content: ChatContentItem[];
  ext?: Record<string, any>;
}

export type ChatMessage = UserMessage | AIMessage;

// ── Socket event types ──────────────────────────────────────────────────────

export interface MessageEvent {
  id: string;
  role: "assistant" | "user" | "system";
  name?: string;
  status: ChatMessageStatus;
  datetime: string;
  content: any[];
  ext?: Record<string, any>;
}

export interface MessageUpdateEvent {
  id: string;
  status?: ChatMessageStatus;
  ext?: Record<string, any>;
}

export interface ContentAddEvent {
  messageId: string;
  content: ChatContentItem;
}

export interface ContentUpdateEvent {
  messageId: string;
  contentId: string;
  type: string;
  data?: any;
  strategy?: "merge" | "append";
  status?: ChatMessageStatus;
}

export interface XmlChildItem {
  tag: string;
  attrs: Record<string, string>;
  value: string;
}

export interface XmlTagEvent {
  messageId: string;
  contentId?: string;
  type: "text" | "markdown";
  tag: string;
  value: string;
  attrs: Record<string, string>;
  children: XmlChildItem[];
  status: ChatMessageStatus;
}

export interface XmlTagOption {
  tag: string;
  keepInMessage?: boolean;
}

export interface ChatSocketEvents {
  chat: { content: string; attachments?: any[] };
  stop: { messageId: string };
  regenerate: { messageId: string };
  message: MessageEvent;
  "message:update": MessageUpdateEvent;
  "content:add": ContentAddEvent;
  "content:update": ContentUpdateEvent;
  error: { code: string; message: string };
}

export interface UseChatOptions {
  url: string;
  auth?: Record<string, any> | (() => Record<string, any>);
  autoConnect?: boolean;
  xmlTags?: Array<string | XmlTagOption>;
  keepXmlInMessage?: boolean;
  onXmlTag?: (event: XmlTagEvent) => void;
  onError?: (error: { code: string; message: string }) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  manageLifecycle?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseXmlAttributes(tagStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tagStr)) !== null) {
    attrs[match[1]] = match[2] ?? match[3];
  }
  return attrs;
}

function parseXmlChildren(content: string): XmlChildItem[] {
  const children: XmlChildItem[] = [];
  const childRegex = /<(\w+)((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = childRegex.exec(content)) !== null) {
    children.push({
      tag: match[1],
      attrs: parseXmlAttributes(match[2]),
      value: match[3] ?? "",
    });
    lastIndex = childRegex.lastIndex;
  }
  const remaining = content.slice(lastIndex);
  const unclosedMatch = remaining.match(/<(\w+)((?:\s+[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>([\s\S]*)$/);
  if (unclosedMatch) {
    children.push({
      tag: unclosedMatch[1],
      attrs: parseXmlAttributes(unclosedMatch[2]),
      value: unclosedMatch[3],
    });
  }
  return children;
}

function parseXmlTag(text: string, tag: string) {
  const escapedTag = escapeRegExp(tag);
  const openRegex = new RegExp(`<${escapedTag}(\\s[^>]*)?>`, "g");
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRegex.exec(text)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;
  const attrs = parseXmlAttributes(lastMatch[1] ?? "");
  const contentStart = lastMatch.index + lastMatch[0].length;
  const closeTag = `</${tag}>`;
  const closeIndex = text.indexOf(closeTag, contentStart);
  const isComplete = closeIndex !== -1;
  const value = text.slice(contentStart, isComplete ? closeIndex : text.length).trim();
  const children = parseXmlChildren(value);
  return { value, attrs, children, isComplete };
}

// ── React Hook ──────────────────────────────────────────────────────────────

export function useChat(options: UseChatOptions) {
  const {
    url,
    auth,
    autoConnect = true,
    xmlTags = [],
    keepXmlInMessage = true,
    onXmlTag,
    onError,
    onConnect,
    onDisconnect,
    manageLifecycle = true,
  } = options;

  // Keep callbacks in refs so they can be used in stable handlers without re-registering.
  const onXmlTagRef = useRef(onXmlTag);
  onXmlTagRef.current = onXmlTag;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  // Reactive state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "pending" | "streaming">("idle");
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);

  // Mutable refs for socket & internal bookkeeping
  const socketRef = useRef<Socket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const lifecycleActiveRef = useRef(true);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const currentMessageIdRef = useRef<string | null>(null);
  currentMessageIdRef.current = currentMessageId;

  // XML tag processing setup
  const normalizedXmlTagOptions = useMemo(
    () =>
      Array.from(
        new Map(
          xmlTags
            .map((item) => (typeof item === "string" ? { tag: item } : item))
            .filter((item): item is XmlTagOption => Boolean(item?.tag))
            .map((item) => [item.tag, item]),
        ).values(),
      ),
    [xmlTags],
  );
  const normalizedXmlTags = useMemo(() => normalizedXmlTagOptions.map((item) => item.tag), [normalizedXmlTagOptions]);
  const hiddenXmlTags = useMemo(
    () => normalizedXmlTagOptions.filter((item) => !(item.keepInMessage ?? keepXmlInMessage)).map((item) => item.tag),
    [normalizedXmlTagOptions, keepXmlInMessage],
  );

  const emittedXmlStateRef = useRef(new Map<string, Record<string, string>>());
  const rawContentStateRef = useRef(new Map<string, string>());

  // ── Internal helpers ──────────────────────────────────────────────────

  const getContentKey = useCallback((messageId: string, content: Pick<ChatContentItem, "id" | "type">) => {
    return `${messageId}:${content.id ?? content.type}`;
  }, []);

  const isXmlTextContent = useCallback((content: ChatContentItem) => {
    return (content.type === "text" || content.type === "markdown") && typeof content.data === "string";
  }, []);

  const getRawContentData = useCallback(
    (messageId: string, content: ChatContentItem) => {
      if (!isXmlTextContent(content)) return null;
      return rawContentStateRef.current.get(getContentKey(messageId, content)) ?? content.data;
    },
    [isXmlTextContent, getContentKey],
  );

  const stripXmlFromMessage = useCallback(
    (text: string) => {
      let sanitized = text;
      for (const tag of hiddenXmlTags) {
        const escapedTag = escapeRegExp(tag);
        sanitized = sanitized.replace(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>`, "g"), "");
        sanitized = sanitized.replace(new RegExp(`<${escapedTag}(?:\\s[^>]*)?>[\\s\\S]*$`, "g"), "");
      }
      return sanitized;
    },
    [hiddenXmlTags],
  );

  const syncContentDisplay = useCallback(
    (messageId: string, content: ChatContentItem) => {
      if (!isXmlTextContent(content)) return;
      const rawText = getRawContentData(messageId, content) ?? "";
      content.data = hiddenXmlTags.length ? stripXmlFromMessage(rawText) : rawText;
    },
    [isXmlTextContent, getRawContentData, hiddenXmlTags, stripXmlFromMessage],
  );

  const syncXmlData = useCallback(
    (messageId: string, content: ChatContentItem, messageStatus?: ChatMessageStatus) => {
      if (!normalizedXmlTags.length) return;
      if (!isXmlTextContent(content)) return;
      const contentKey = getContentKey(messageId, content);
      const prevState = emittedXmlStateRef.current.get(contentKey) ?? {};
      const nextState = { ...prevState };
      const statusVal = content.status ?? messageStatus ?? "pending";
      const rawText = getRawContentData(messageId, content);
      if (rawText === null) return;
      let changed = false;
      for (const tag of normalizedXmlTags) {
        const parsed = parseXmlTag(rawText, tag);
        if (parsed === null) continue;
        const { value, isComplete } = parsed;
        const eventStatus = isComplete ? (statusVal === "error" || statusVal === "stop" ? statusVal : "complete") : statusVal;
        const shouldEmit = prevState[tag] !== value || eventStatus === "complete";
        if (!shouldEmit) continue;
        nextState[tag] = value;
        changed = true;
        onXmlTagRef.current?.({
          messageId,
          contentId: content.id,
          type: content.type as "text" | "markdown",
          tag,
          value,
          attrs: parsed.attrs,
          children: parsed.children,
          status: eventStatus,
        });
      }
      if (changed) {
        emittedXmlStateRef.current.set(contentKey, nextState);
      }
    },
    [normalizedXmlTags, isXmlTextContent, getContentKey, getRawContentData],
  );

  // ── Connect / Disconnect ──────────────────────────────────────────────

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    clearReconnectTimer();
    if (!lifecycleActiveRef.current) return;
    if (socketRef.current?.connected || connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);

    if (!socketRef.current) {
      const s = io(url, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 10000,
        auth: { token: localStorage.getItem("token"), ...(typeof auth === "function" ? auth() : auth) },
      });
      socketRef.current = s;

      // ── Socket event handlers ──
      s.on("message", (data: MessageEvent) => {
        const newMessage = {
          id: data.id,
          role: data.role as ChatMessage["role"],
          name: data.name,
          status: data.status || "pending",
          datetime: data.datetime,
          content: data.content || [],
          ext: data.ext,
        } as ChatMessage;
        if (data.role === "assistant") {
          const aiMsg = newMessage as AIMessage;
          aiMsg.content?.forEach((content) => {
            if (isXmlTextContent(content)) {
              rawContentStateRef.current.set(getContentKey(data.id, content), content.data);
              syncContentDisplay(data.id, content);
            }
          });
        }
        setMessages((prev) => [...prev, newMessage]);
        if (data.role === "assistant") {
          setCurrentMessageId(data.id);
          setStatus(data.status === "streaming" ? "streaming" : "pending");
        }
      });

      s.on("message:update", (data: MessageUpdateEvent) => {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === data.id);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], status: data.status ?? next[idx].status, ext: { ...next[idx].ext, ...data.ext } };
          return next;
        });
        if (data.status === "complete" || data.status === "error" || data.status === "stop") {
          setCurrentMessageId((prev) => {
            if (prev === data.id) {
              setStatus("idle");
              return null;
            }
            return prev;
          });
        }
        if (data.status === "streaming") {
          setStatus("streaming");
        }
      });

      s.on("content:add", (data: ContentAddEvent) => {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === data.messageId);
          if (idx === -1 || prev[idx].role !== "assistant") return prev;
          const next = [...prev];
          const msg = { ...next[idx] } as AIMessage;
          const content = { ...data.content, status: data.content.status || "pending" };
          if (isXmlTextContent(content)) {
            rawContentStateRef.current.set(getContentKey(data.messageId, content), content.data);
            syncContentDisplay(data.messageId, content);
          }
          msg.content = [...(msg.content || []), content];
          next[idx] = msg;
          return next;
        });
      });

      s.on("content:update", (event: ContentUpdateEvent) => {
        const { messageId, contentId, data: updateData, strategy, status: eventStatus } = event;
        // Update raw content state
        setMessages((prev) => {
          const msgIdx = prev.findIndex((m) => m.id === messageId);
          if (msgIdx === -1 || prev[msgIdx].role !== "assistant") return prev;
          const next = [...prev];
          const msg = { ...next[msgIdx] } as AIMessage;
          const contentIdx = msg.content?.findIndex((c) => c.id === contentId) ?? -1;
          if (contentIdx === -1 || !msg.content) return prev;
          const content = { ...msg.content[contentIdx] };
          if (eventStatus) content.status = eventStatus;

          if (updateData !== undefined && updateData !== null && isXmlTextContent(content) && typeof updateData === "string") {
            const contentKey = getContentKey(messageId, content);
            const previousRaw = rawContentStateRef.current.get(contentKey) ?? content.data;
            const nextRaw = strategy === "append" ? previousRaw + updateData : updateData;
            rawContentStateRef.current.set(contentKey, nextRaw);
            content.data = hiddenXmlTags.length ? stripXmlFromMessage(nextRaw) : nextRaw;
          } else if (updateData !== undefined && updateData !== null) {
            if (strategy === "append" && typeof content.data === "string" && typeof updateData === "string") {
              content.data += updateData;
            } else {
              content.data = updateData;
            }
          }

          msg.content = [...msg.content];
          msg.content[contentIdx] = content;
          if ((eventStatus === "streaming" || strategy === "append") && msg.status === "pending") {
            msg.status = "streaming";
          }
          next[msgIdx] = msg;
          return next;
        });
      });

      s.on("error", (error: { code: string; message: string }) => {
        console.error("[Chat Error]", error);
        onErrorRef.current?.(error);
      });

      s.on("connect", () => {
        setConnected(true);
        connectingRef.current = false;
        setConnecting(false);
        onConnectRef.current?.();
      });

      s.on("disconnect", (reason: string) => {
        setConnected(false);
        connectingRef.current = false;
        setConnecting(false);
        onDisconnectRef.current?.();
        console.log("[Chat Disconnected]", reason);
      });

      s.on("connect_error", (error: Error) => {
        setConnected(false);
        connectingRef.current = false;
        setConnecting(false);
        console.error("[Chat Connect Error]", error);
      });
    } else {
      socketRef.current.connect();
    }
  }, [url, auth, isXmlTextContent, getContentKey, syncContentDisplay, hiddenXmlTags, stripXmlFromMessage, clearReconnectTimer]);

  const disconnect = useCallback(() => {
    clearReconnectTimer();
    socketRef.current?.disconnect();
    connectingRef.current = false;
    setConnected(false);
    setConnecting(false);
  }, [clearReconnectTimer]);

  const reconnect = useCallback(() => {
    disconnect();
    if (!lifecycleActiveRef.current) return;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (lifecycleActiveRef.current) connect();
    }, 100);
  }, [disconnect, connect]);

  // ── Send methods ──────────────────────────────────────────────────────

  const emit = useCallback(
    <E extends keyof ChatSocketEvents & string>(event: E, data?: ChatSocketEvents[E]) => {
      if (!socketRef.current?.connected) {
        console.warn("[Chat] Socket not connected");
        return false;
      }
      socketRef.current.emit(event, data);
      return true;
    },
    [],
  );

  const chat = useCallback(
    (content: string, attachments?: any[]) => {
      if (!content.trim() && !attachments?.length) return false;
      if (!socketRef.current?.connected) {
        console.warn("[Chat] Socket not connected, message not sent");
        return false;
      }
      const userMessage: UserMessage = {
        id: `user_${Date.now()}`,
        role: "user",
        status: "complete",
        datetime: new Date().toISOString(),
        content: [{ type: "text", data: content, status: "complete" }],
      };
      if (attachments?.length) {
        userMessage.content.push({ type: "attachment", data: attachments, status: "complete" });
      }
      setMessages((prev) => [...prev, userMessage]);
      return emit("chat", { content, attachments });
    },
    [emit],
  );

  const stopGenerate = useCallback(
    (messageId?: string) => {
      const id = messageId || currentMessageIdRef.current;
      if (!id) return false;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "stop" as ChatMessageStatus } : m)));
      setCurrentMessageId(null);
      setStatus("idle");
      return emit("stop", { messageId: id });
    },
    [emit],
  );

  const regenerate = useCallback((messageId: string) => emit("regenerate", { messageId }), [emit]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setCurrentMessageId(null);
    setStatus("idle");
    emittedXmlStateRef.current.clear();
    rawContentStateRef.current.clear();
  }, []);

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => {
      const msg = prev.find((m) => m.id === id);
      if (msg && msg.role === "assistant") {
        (msg as AIMessage).content?.forEach((content) => {
          emittedXmlStateRef.current.delete(`${id}:${content.id ?? content.type}`);
          rawContentStateRef.current.delete(`${id}:${content.id ?? content.type}`);
        });
      }
      return prev.filter((m) => m.id !== id);
    });
  }, []);

  const findMessage = useCallback((id: string) => messagesRef.current.find((m) => m.id === id), []);

  const isGenerating = useMemo(() => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return false;
    if (lastMsg.status === "pending" || lastMsg.status === "streaming") return true;
    const aiMsg = lastMsg as AIMessage;
    if (aiMsg.content?.some((c) => c.status === "pending" || c.status === "streaming")) return true;
    return false;
  }, [messages]);

  const lastMessage = useMemo(() => messages[messages.length - 1], [messages]);

  // ── Lifecycle ─────────────────────────────────────────────────────────

  useEffect(() => {
    lifecycleActiveRef.current = true;
    if (manageLifecycle && autoConnect) {
      connect();
    }
    return () => {
      lifecycleActiveRef.current = false;
      clearReconnectTimer();
      connectingRef.current = false;
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    socket: socketRef,
    connected,
    connecting,
    status,
    messages,
    currentMessageId,
    isGenerating,
    lastMessage,
    connect,
    disconnect,
    reconnect,
    emit,
    chat,
    stopGenerate,
    regenerate,
    clearMessages,
    removeMessage,
    findMessage,
  };
}

export type UseChatReturn = ReturnType<typeof useChat>;
