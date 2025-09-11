export interface DanbooruRequest {
  jobId: string;
  query: string;
}

export interface DanbooruResponse {
  jobId: string;
  imageUrl: string;
  author: string | null;
  tags: string;
  rating: string;
  source: string | null;
  copyright: string;
}

export interface DanbooruErrorResponse {
  jobId: string;
  error: string;
}
