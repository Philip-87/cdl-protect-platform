import type { MouseEventHandler, ReactNode } from 'react'

export function SignOutForm({
  className,
  children,
  formClassName,
  onClick,
}: {
  className: string
  children: ReactNode
  formClassName?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <form action="/logout" method="post" className={formClassName}>
      <button type="submit" className={className} onClick={onClick}>
        {children}
      </button>
    </form>
  )
}
