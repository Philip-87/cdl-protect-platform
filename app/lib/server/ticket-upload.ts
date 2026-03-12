export const MAX_TICKET_UPLOAD_BYTES = 12 * 1024 * 1024

export function isSupportedTicketUploadType(mimeType: string | null | undefined) {
  const normalized = String(mimeType ?? '').trim().toLowerCase()
  if (!normalized) return false
  return normalized === 'application/pdf' || normalized.startsWith('image/')
}

export function validateTicketUpload(file: Pick<File, 'size' | 'type'>, fieldName: string) {
  if (!file.size) {
    return `${fieldName} is required.`
  }

  if (file.size > MAX_TICKET_UPLOAD_BYTES) {
    return `${fieldName} exceeds 12MB limit.`
  }

  if (!isSupportedTicketUploadType(file.type)) {
    return `${fieldName} must be a PDF or image upload.`
  }

  return null
}
