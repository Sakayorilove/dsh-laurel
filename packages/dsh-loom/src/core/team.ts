import { ID_PATTERN, type WorkflowRevision } from './model.js'
export interface TeamMember {id:string;label:string;role:'executor'|'supervisor'|'reviewer';responsibility:string;taskIds:string[]}
export interface ResponsibilityTeam {id:string;label:string;taskIds:string[];supervisorId:string;reviewerId:string}
export interface TeamPlan {members:TeamMember[];teams:ResponsibilityTeam[];communicationRounds:number}
export function validateTeamPlan(input:unknown,workflow:WorkflowRevision):TeamPlan {
  const raw=input as any
  if(!raw||!Array.isArray(raw.members)||raw.members.length>48||!Array.isArray(raw.teams)||raw.teams.length>12||![0,1,2].includes(raw.communicationRounds))throw new Error('TEAM_INVALID: 成员最多48、责任组最多12、沟通轮数0..2')
  const ids=new Set<string>(),tasks=new Set(workflow.nodes.map(n=>n.id)),assigned=new Set<string>()
  const members:TeamMember[]=raw.members.map((m:any)=>{
    if(!m||!ID_PATTERN.test(m.id)||ids.has(m.id)||!['executor','supervisor','reviewer'].includes(m.role)||typeof m.label!=='string'||!m.label.trim()||typeof m.responsibility!=='string'||m.responsibility.length>4000||!Array.isArray(m.taskIds)||new Set(m.taskIds).size!==m.taskIds.length||m.taskIds.some((id:any)=>!tasks.has(id)))throw new Error('TEAM_INVALID: 成员身份/职责/任务不合法')
    ids.add(m.id)
    if(m.role==='executor')for(const id of m.taskIds){if(assigned.has(id))throw new Error('TEAM_INVALID: 一个任务只能有一位执行负责人');assigned.add(id)}
    else if(m.taskIds.length)throw new Error('TEAM_INVALID: 分管/独立审查不得兼任实现')
    return {id:m.id,label:m.label.slice(0,80),role:m.role,responsibility:m.responsibility,taskIds:[...m.taskIds]}
  })
  if(workflow.nodes.some(n=>!assigned.has(n.id)))throw new Error('TEAM_INVALID: 每个任务必须有执行负责人')
  const teamIds=new Set<string>(),grouped=new Set<string>()
  const teams:ResponsibilityTeam[]=raw.teams.map((t:any)=>{
    if(!t||!ID_PATTERN.test(t.id)||teamIds.has(t.id)||typeof t.label!=='string'||!t.label.trim()||!Array.isArray(t.taskIds)||!t.taskIds.length||new Set(t.taskIds).size!==t.taskIds.length||t.taskIds.some((id:any)=>!tasks.has(id)||grouped.has(id)))throw new Error('TEAM_INVALID: 责任组身份与任务不合法/重复')
    const supervisor=members.find(m=>m.id===t.supervisorId),reviewer=members.find(m=>m.id===t.reviewerId)
    if(supervisor?.role!=='supervisor'||reviewer?.role!=='reviewer'||supervisor.id===reviewer.id)throw new Error('TEAM_INVALID: 责任组必须有分管和独立审查员')
    teamIds.add(t.id);for(const id of t.taskIds)grouped.add(id)
    return {id:t.id,label:t.label.slice(0,80),taskIds:[...t.taskIds],supervisorId:t.supervisorId,reviewerId:t.reviewerId}
  })
  return {members,teams,communicationRounds:raw.communicationRounds}
}
