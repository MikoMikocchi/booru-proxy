export interface DanbooruRequest {
  jobId: string
  query: string
}

export interface DanbooruSuccessResponse {
  type: 'success'
  jobId: string
  imageUrl: string
  author: string | null
  tags: string
  rating: string
  source: string | null
  copyright: string
}

export interface DanbooruErrorResponse {
  type: 'error'
  jobId: string
  error: string
}

export type DanbooruResponse = DanbooruSuccessResponse | DanbooruErrorResponse
