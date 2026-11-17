import clsx from 'clsx'
import styles from './Switch.module.css'

/** 开关：轨道 + 圆点，开启时为品牌色；ariaLabel 作为无障碍名称 */
export const Switch = ({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel: string
  className?: string
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    className={clsx(styles.switch, checked && styles.checked, className)}
    onClick={() => onChange(!checked)}
  >
    <span className={styles.thumb} />
  </button>
)
