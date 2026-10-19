import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AxkhIntegrationButton, { shouldShowAxkhEntry } from './AxkhIntegrationButton'

const props = { className: 'c', labelClassName: 'l' }

describe('shouldShowAxkhEntry (post-recording visibility)', () => {
  const ready = { uiEnabled: true, noteId: 'n1', ownerKnown: true, summarizing: false, summary: 'text' }
  it('shows only when the summary is ready for a saved note', () => {
    expect(shouldShowAxkhEntry(ready)).toBe(true)
  })
  it('hides without a note id', () => {
    expect(shouldShowAxkhEntry({ ...ready, noteId: null })).toBe(false)
  })
  it('hides while the summary is generating or empty', () => {
    expect(shouldShowAxkhEntry({ ...ready, summarizing: true })).toBe(false)
    expect(shouldShowAxkhEntry({ ...ready, summary: '  ' })).toBe(false)
    expect(shouldShowAxkhEntry({ ...ready, summary: null })).toBe(false)
  })
  it('hides when the feature flag is off or the owner is unknown', () => {
    expect(shouldShowAxkhEntry({ ...ready, uiEnabled: false })).toBe(false)
    expect(shouldShowAxkhEntry({ ...ready, ownerKnown: false })).toBe(false)
  })
})

describe('AxkhIntegrationButton', () => {
  afterEach(() => cleanup())
  it('is prominent once a summary exists and only opens the modal (no send)', async () => {
    const onOpen = vi.fn()
    render(<AxkhIntegrationButton {...props} summaryReady language="ko" onOpen={onOpen} />)
    const button = screen.getByRole('button', { name: 'AXKH로 보내기' })
    expect(button).toHaveAttribute('data-prominent', 'true')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
  it('stays the regular entry before a summary is ready', () => {
    render(<AxkhIntegrationButton {...props} summaryReady={false} language="en" onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: 'AXKH integration · attendance' })).not.toHaveAttribute('data-prominent')
  })
})
