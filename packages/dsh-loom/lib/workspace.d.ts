/** Tool ownership always comes from the real calling agent. */
export declare function toolWorkspace(exec: unknown): string | null;
/** Resolve a selected session through the public host query service, never a client cwd. */
export declare function requestWorkspace(req: any, sessionQuery: any): Promise<string | null>;
/**
 * 校验「这个 sessionId 在宿主里真的存在」，但**不要求它已经有工作区**。
 *
 * 为什么需要它：会话态开关（规划模式、总开关）只按 sessionId 记账，压根用不到
 * 工作区 —— 而新对话恰恰是「还没有工作区、但最该能先设好这些开关」的时刻。
 * 之前这些端点复用 `requestWorkspace` 的判据（「有 cwd 才算数」），于是新对话里
 * 它们被当成「会话不存在」拒掉。
 *
 * 身份校验没有被放宽：仍然是**问宿主**，而不是采信客户端塞的 header。
 * 区别只在于判据从「有 cwd」变成「这个会话查得到」。
 */
export declare function requestSessionExists(req: any, sessionQuery: any): Promise<string | null>;
