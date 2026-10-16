import { type HostHelpers } from './provider.js';
export declare function loadHostHelpers(): HostHelpers;
export declare function loadHostShellBindings(): {
    ShellExecutor: any;
    applyBashTool: (ctx: any, config: any) => void;
    bashTools: any;
};
export declare function loadHostFsBindings(): {
    FileSystem: any;
    FsError: any;
    fileTools: any;
};
