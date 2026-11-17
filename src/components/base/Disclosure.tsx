import clsx from 'clsx'
import { useId, useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from './icons.js'
import styles from './Disclosure.module.css'

/**
 * 折叠区：标题行是一个按钮（箭头 + 标题 + 可选的「· 数量」），右侧可放操作；展开时才渲染内容。
 * 传 open 时受控，否则用 defaultOpen 作为初始状态。样式参照回答里思考过程的折叠标题。
 */
export const Disclosure = ({
  title,
  count,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  action,
  className,
  contentClassName,
  children,
}: {
  title: ReactNode
  count?: number
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** 标题行右侧的操作，不参与展开收起 */
  action?: ReactNode
  className?: string
  contentClassName?: string
  children: ReactNode
}) => {
  const contentId = useId()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const toggle = () => {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(!open)
    }
    onOpenChange?.(!open)
  }
  return (
    <div className={clsx(styles.disclosure, className)}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
          onClick={toggle}
        >
          <span className={styles.chevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
          <span className={styles.title}>{title}</span>
          {count === undefined ? null : <span className={styles.count}>· {count}</span>}
        </button>
        {action ? <div className={styles.action}>{action}</div> : null}
      </div>
      {open ? (
        <div id={contentId} className={clsx(styles.content, contentClassName)}>
          {children}
        </div>
      ) : null}
    </div>
  )
}
