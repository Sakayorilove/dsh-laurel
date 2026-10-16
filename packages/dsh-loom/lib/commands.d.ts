import type { LoomStore } from './store.js';
import type { LoomConfig } from './config.js';
export interface CommandDeps {
    planning?: import('./planning.js').PlanningController;
    store: LoomStore;
    getConfig: () => LoomConfig;
    scmFacts: (cwd: string, sessionId?: string) => Promise<{
        repo: string;
        head: string;
        dirty: boolean;
    }>;
    runWorkflow: (workflow: any, exec: any, args: any) => Promise<any>;
    cancelRun: (runId: string) => Promise<boolean>;
    log: {
        warn: (...args: unknown[]) => void;
    };
}
export declare function registerCommands(ctx: any, deps: CommandDeps): void;
