import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import MeetingKnowledgeModal from './MeetingKnowledgeModal'
import { MeetingKnowledgeApiError, type MeetingKnowledgeStatus } from '../services/meetingKnowledge'

const getStatus = vi.fn()
const mutate = vi.fn()
vi.mock('../services/meetingKnowledge', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/meetingKnowledge')>()),
  getMeetingKnowledgeStatus: (...args: unknown[]) => getStatus(...args),
  mutateMeetingKnowledge: (...args: unknown[]) => mutate(...args),
}))
const auth = { getAccessToken: async () => null }
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))
const language = { appLanguage: 'ko' }
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => language }))
vi.mock('../services/microsoftContacts', () => ({ fetchTecAceContacts: async () => [] }))

const base = (patch: Partial<MeetingKnowledgeStatus> = {}): MeetingKnowledgeStatus => ({
  sourceId: 'n1', enrolled: false, unsupportedTranscript: false, integrationEnabled: false, accessRevision: null,
  integrationGeneration: null, participants: [], denies: [], directShares: [], projectShares: [],
  delivery: { pending: 0, lastDeliveredAt: null, lastErrorCode: null }, ...patch,
})
const enrolled = (patch: Partial<MeetingKnowledgeStatus> = {}) => base({ enrolled: true, accessRevision: 1, integrationGeneration: 1, ...patch })

describe('MeetingKnowledgeModal one-click send', () => {
  afterEach(() => cleanup())
  beforeEach(() => { getStatus.mockReset(); mutate.mockReset() })

  it('sends a single enable_all request without a revision and offers optional attendance afterwards', async () => {
    getStatus.mockResolvedValueOnce(base()).mockResolvedValue(enrolled({ integrationEnabled: true, accessRevision: 2 }))
    mutate.mockResolvedValue(undefined)
    render(<MeetingKnowledgeModal noteId="n1" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '연동하고 전송 켜기' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate.mock.calls[0][0]).toEqual({ action: 'enable_all', sourceId: 'n1' })
    expect(await screen.findByText(/전송이 켜졌습니다/)).toBeInTheDocument()
    expect(screen.getByText('전송 켜짐')).toBeInTheDocument()
  })

  it('is disabled for unsupported transcripts and never auto-sends on open', async () => {
    getStatus.mockResolvedValue(base({ unsupportedTranscript: true }))
    render(<MeetingKnowledgeModal noteId="n1" onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: '연동하고 전송 켜기' })).toBeDisabled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('on partial failure shows the safe state and a retry via enable', async () => {
    getStatus.mockResolvedValueOnce(base()).mockResolvedValue(enrolled())
    mutate.mockRejectedValueOnce(new MeetingKnowledgeApiError(503, true))
    render(<MeetingKnowledgeModal noteId="n1" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '연동하고 전송 켜기' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('전송은 꺼져 있는 안전한 상태')
    expect(await screen.findByRole('button', { name: '전송 켜기' })).toBeEnabled()
    mutate.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: '전송 켜기' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1][0]).toMatchObject({ action: 'enable', expectedAccessRevision: 1 })
  })

  it('explains blocked sources (422) clearly', async () => {
    getStatus.mockResolvedValueOnce(base()).mockResolvedValue(enrolled({ processing: undefined }))
    mutate.mockRejectedValueOnce(new MeetingKnowledgeApiError(422, true))
    render(<MeetingKnowledgeModal noteId="n1" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: '연동하고 전송 켜기' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('1MB 이하')
  })
})
