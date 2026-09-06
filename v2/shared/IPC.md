# Renderer IPC contract

window.akorith.invoke<T>(command,payload) returns Promise<T>, rejects readable errors. onEvent/onHostEvent return unsubscribe. Shared types in contracts.ts. File paths are validated against persisted task cwd.

- app:snapshot → AppSnapshot; providers:refresh → ProviderInfo[].
- project:open native directory picker → Project|null; project:add {path} → Project.
- task:create {projectId?:string|null,providerId?:ProviderId,model?:string} → Task.
- task:read {taskId} → TaskDetail.
- task:update {taskId,patch:{title?,pinned?,archived?,draft?,providerId?,model?,effort?,mode?}} → Task.
- task:send {taskId,requestId,prompt,attachments?:Attachment[]} → {turnId}. Active task queues another turn.
- task:stop {taskId}; task:steer {taskId,text}; task:respond {taskId,requestId,response}.
- attachments:add {taskId} native picker → Attachment[].
- settings:update {patch:Partial<Settings>} → Settings.
- skills:list → SkillInfo[]; skills:toggle {id,enabled} → SkillInfo[].
- mcp:save {server:McpServer} → McpServer[]; mcp:probe {id} → McpServer; mcp:remove {id} → McpServer[].
- app:openExternal {url} http/https only; app:reveal {taskId,path} contained path.
- history:import → {projects:number,tasks:number,messages:number,warnings:string[]} old app read-only snapshot import.
- files:list {taskId,path?:string} → FileEntry[]; files:read {taskId,path} → {path,content,truncated,binary?}; files:write {taskId,path,content,expectedHash?} → {ok,hash}.
- git:status {taskId} → GitStatus; git:diff {taskId,path?:string} → {diff}; git:stage {taskId,path,staged:boolean}.
- terminal:create {taskId,cols,rows} → {id}; terminal:write {taskId,id,data}; terminal:resize {taskId,id,cols,rows}; terminal:close {taskId,id}. Host events terminal:data {id,data}, terminal:exit {id,code}.
- browser:create {taskId,url?:string} → BrowserState; browser:attach {taskId,id,bounds:{x,y,width,height},visible:boolean}; browser:navigate {taskId,id,url}; browser:action {taskId,id,action:'back'|'forward'|'reload'}; browser:close {taskId,id}. Host event browser:state {state:BrowserState}.
- computer:state → ComputerState; computer:permissions → ComputerState; computer:capture {bundleId?:string} → {dataUrl}; computer:stop. Other computer actions through host tools.
- preview:start {taskId} → {url}; preview:stop {taskId}.

AppEvent message carries full changed message (batch ~50ms), task carries updated Task, changed for structural updates, pending for approvals, notice for feedback. Do not refetch entire state every token.

Queue commands: `task:queue {taskId}` returns queued turns `{id,prompt,providerId,model,effort,mode,createdAt,...}`. `task:queueEdit {taskId,turnId,prompt}` updates only a still-queued prompt; `task:queueRemove {taskId,turnId}` cancels only that queued turn. Both emit changed(taskId); an already running turn returns an error.
