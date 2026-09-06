import { Check, Copy, ExternalLink } from 'lucide-react'
import { createContext, memo, useContext, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, basename } from '../api'
import { useArtifactPreview } from './ArtifactPreview'

export const TaskSurfaceContext = createContext<string | null>(null)
function ArtifactImage({
  src,
  alt,
  onError,
}: {
  src?: string
  alt?: string
  onError: (error: unknown) => void
}) {
  const taskId = useContext(TaskSurfaceContext)
  const preview = useArtifactPreview()
  const [data, setData] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const local = !!src && !/^[a-z]+:/i.test(src)
  useEffect(() => {
    setData(null)
    setUnavailable(false)
    if (!taskId || !src || !local) return
    let disposed = false
    void api<{ dataUrl: string }>('files:media', { taskId, path: src })
      .then((result) => {
        if (!disposed) setData(result.dataUrl)
      })
      .catch(() => {
        if (!disposed) setUnavailable(true)
      })
    return () => {
      disposed = true
    }
  }, [taskId, src, local])
  if (data)
    return (
      <button
        className="artifact-image"
        onClick={() => src && preview?.({ path: src, name: alt || basename(src), kind: 'image' })}
        disabled={!preview}
        title="Preview image"
      >
        <img src={data} alt={alt || 'Task artifact'} loading="lazy" />
        {alt ? <span>{alt}</span> : null}
      </button>
    )
  return (
    <span className="image-reference">
      {alt || 'Image'}
      <small>{local && !unavailable ? 'Loading…' : ''}</small>
      {src && (local || /^https?:\/\//i.test(src)) ? (
        <button
          className="text-button"
          onClick={() => {
            if (/^https?:\/\//i.test(src)) void api('app:openExternal', { url: src }).catch(onError)
            else preview?.({ path: src, name: alt || basename(src), kind: 'image' })
          }}
          disabled={local && !preview}
        >
          Open image
        </button>
      ) : null}
    </span>
  )
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-block">
      <button
        className="code-copy"
        aria-label="Copy code"
        onClick={(event) => {
          const code = event.currentTarget.parentElement?.querySelector('pre')?.textContent || ''
          void navigator.clipboard
            .writeText(code)
            .then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            })
            .catch(() => {})
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}
export const Markdown = memo(function Markdown({
  text,
  onOpenFile,
  onError,
}: {
  text: string
  onOpenFile: (path: string) => void
  onError: (error: unknown) => void
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault()
                if (!href) return
                if (/^https?:\/\//i.test(href))
                  void api('app:openExternal', { url: href }).catch(onError)
                else if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#')) {
                  try {
                    onOpenFile(
                      decodeURI(href)
                        .replace(/#L\d+(?:-L?\d+)?$/, '')
                        .replace(/:\d+(?::\d+)?$/, ''),
                    )
                  } catch (error) {
                    onError(error)
                  }
                }
              }}
            >
              {children}
              {/^https?:\/\//i.test(href || '') ? (
                <ExternalLink size={10} className="inline-external" />
              ) : null}
            </a>
          ),
          img: ({ src, alt }) => (
            <ArtifactImage src={src} alt={alt} onError={onError} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
