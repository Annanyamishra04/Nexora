/**
 * Hand-written Supabase types for Phase 1.
 *
 * Once the schema stabilizes, replace this file with generated types:
 *   npx supabase gen types typescript --project-id <id> > lib/supabase/types.ts
 */
/** A user message's metadata when a document was attached to that turn. */
export interface DocumentAttachmentMetadata {
  documentId: string;
  filename: string;
}

/** A single retrieved chunk that actually informed an assistant reply — server-derived, never model-generated. See lib/rag/retrieval.ts. */
export interface SourceRef {
  documentId: string;
  filename: string;
  chunkId: string;
  chunkIndex: number;
  /** Cosine similarity in [-1, 1] between the query and this chunk. */
  similarity: number;
  /**
   * The retrieved chunk text itself (already bounded by
   * RAG_MAX_CHARS_PER_CHUNK) — included so the UI can show "why this
   * answer" without a second round trip. Never more than what was
   * already placed in the model's prompt for this turn; see
   * "Source preview" in docs/ARCHITECTURE.md.
   */
  content: string;
}

/** An assistant message's metadata when its reply was grounded in retrieved document chunks. */
export interface AssistantSourcesMetadata {
  sources: SourceRef[];
}

export type MessageMetadata = DocumentAttachmentMetadata | AssistantSourcesMetadata;

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      conversations: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          title?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          created_at?: string;
          updated_at?: string;
        };
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          user_id: string;
          role: "user" | "assistant" | "system";
          content: string;
          status: "complete" | "incomplete";
          metadata: MessageMetadata | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          user_id: string;
          role: "user" | "assistant" | "system";
          content: string;
          status?: "complete" | "incomplete";
          metadata?: MessageMetadata | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          user_id?: string;
          role?: "user" | "assistant" | "system";
          content?: string;
          status?: "complete" | "incomplete";
          metadata?: MessageMetadata | null;
          created_at?: string;
        };
      };
      documents: {
        Row: {
          id: string;
          user_id: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          storage_path: string | null;
          extracted_text: string;
          extraction_status: "processing" | "ready" | "failed";
          embedding_model: string | null;
          embedding_dimensions: number | null;
          chunk_count: number;
          processing_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          storage_path?: string | null;
          extracted_text: string;
          extraction_status?: "processing" | "ready" | "failed";
          embedding_model?: string | null;
          embedding_dimensions?: number | null;
          chunk_count?: number;
          processing_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          filename?: string;
          mime_type?: string;
          size_bytes?: number;
          storage_path?: string | null;
          extracted_text?: string;
          extraction_status?: "processing" | "ready" | "failed";
          embedding_model?: string | null;
          embedding_dimensions?: number | null;
          chunk_count?: number;
          processing_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      conversation_documents: {
        Row: {
          conversation_id: string;
          document_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: {
          conversation_id: string;
          document_id: string;
          user_id: string;
          created_at?: string;
        };
        Update: {
          conversation_id?: string;
          document_id?: string;
          user_id?: string;
          created_at?: string;
        };
      };
      document_chunks: {
        Row: {
          id: string;
          document_id: string;
          user_id: string;
          chunk_index: number;
          content: string;
          embedding: number[];
          metadata: ChunkMetadata;
          created_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          user_id: string;
          chunk_index: number;
          content: string;
          embedding: number[];
          metadata?: ChunkMetadata;
          created_at?: string;
        };
        Update: {
          id?: string;
          document_id?: string;
          user_id?: string;
          chunk_index?: number;
          content?: string;
          embedding?: number[];
          metadata?: ChunkMetadata;
          created_at?: string;
        };
      };
    };
    Views: Record<string, never>;
    Functions: {
      match_document_chunks: {
        Args: {
          query_embedding: number[];
          match_count?: number;
          filter_document_ids?: string[] | null;
        };
        Returns: {
          id: string;
          document_id: string;
          chunk_index: number;
          content: string;
          metadata: ChunkMetadata;
          similarity: number;
        }[];
      };
      /** Phase 5 — see supabase/migrations/0007_conversation_search.sql. */
      search_conversations: {
        Args: {
          search_query: string;
          result_limit?: number;
        };
        Returns: {
          id: string;
          title: string;
          updated_at: string;
          match_type: "title" | "message";
          snippet: string | null;
        }[];
      };
      /** Phase 6 — see supabase/migrations/0008_rate_limits.sql and 0009_rate_limit_hardening.sql. */
      check_rate_limit: {
        Args: {
          p_action: string;
          p_limit: number;
        };
        Returns: {
          allowed: boolean;
          current_count: number;
          retry_after_seconds: number;
        }[];
      };
    };
  };
}

/** Small, structured extras for citations — never duplicates full document text. See lib/rag/pipeline.ts. */
export interface ChunkMetadata {
  filename: string;
  contentType: string;
  [key: string]: unknown;
}
