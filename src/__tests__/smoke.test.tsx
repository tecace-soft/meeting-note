import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { formatMeetingDuration } from '../lib/noteDuration'

// Trivial smoke suite that proves the frontend test runner is wired up end to
// end: the Vitest runner itself, TypeScript resolution of real `src/` modules,
// jsdom + React Testing Library rendering, and the jest-dom matchers. It does
// NOT exercise real app components yet (strangler step T2-0).
describe('frontend test runner smoke test', () => {
  it('runs the test runner', () => {
    expect(1 + 1).toBe(2)
  })

  it('imports and exercises a pure src util', () => {
    expect(formatMeetingDuration(3661)).toBe('1:01:01')
    expect(formatMeetingDuration(61)).toBe('1:01')
    expect(formatMeetingDuration(0)).toBeNull()
  })

  it('renders a component into jsdom and finds it with jest-dom', () => {
    function Hello() {
      return <p>hello meeting-note</p>
    }
    render(<Hello />)
    expect(screen.getByText('hello meeting-note')).toBeInTheDocument()
  })
})
