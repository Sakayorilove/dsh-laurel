import { type WorkflowRevision } from './model.js';
export interface TeamMember {
    id: string;
    label: string;
    role: 'executor' | 'supervisor' | 'reviewer';
    responsibility: string;
    taskIds: string[];
}
export interface ResponsibilityTeam {
    id: string;
    label: string;
    taskIds: string[];
    supervisorId: string;
    reviewerId: string;
}
export interface TeamPlan {
    members: TeamMember[];
    teams: ResponsibilityTeam[];
    communicationRounds: number;
}
export declare function validateTeamPlan(input: unknown, workflow: WorkflowRevision): TeamPlan;
