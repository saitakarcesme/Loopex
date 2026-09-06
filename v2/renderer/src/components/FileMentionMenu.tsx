import { useEffect, useRef } from 'react'
import type { ProjectFileChoice } from '../../../shared/project-files'
export function FileMentionMenu({files, index, loading, error, onChoose}: {files:ProjectFileChoice[];index:number;loading:boolean;error:string;onChoose:(file:ProjectFileChoice)=>void}) {
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => { menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block:'nearest' }) }, [index])
  return <div ref={menu} className="file-mention-menu" id="file-mention-list" role="listbox" aria-label="Project files">
    <div className="file-mention-heading">Project files <span>↑ ↓ to choose · Enter to attach · Esc to close</span></div>
    {files.map((file,i)=><div id={`file-mention-${i}`} key={file.path} role="option" aria-selected={index===i} className={index===i?'selected':''} onMouseDown={event=>event.preventDefault()} onClick={()=>onChoose(file)}>{file.path}</div>)}
    {!files.length ? <div role="status">{loading?'Searching project files…':error || 'No matching files. Hidden files, links and common credential filenames are excluded.'}</div>:null}
  </div>
}
