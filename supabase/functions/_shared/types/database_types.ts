import type {
  Database as DatabaseGenerated,
  Json,
  Tables,
} from "../db_types.ts";
import { MergeDeep } from "https://esm.sh/type-fest@^4.11.1";
import type {
  IncomingMessage,
  InternalMessage,
  OutgoingMessage,
} from "./message_types.ts";
import type { IncomingStatus, OutgoingStatus } from "./status_types.ts";
import type { ConversationType } from "./conversation_types.ts";
import type {
  AIAgentExtra,
  ContactAddressExtra,
  ConversationExtra,
  OrganizationAddressExtra,
  OrganizationExtra,
} from "./extra_types.ts";

export type { Json, Tables };

type AgentExtra = AIAgentExtra;

type KnowledgeBaseRowShape = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type KnowledgeDocumentRowShape = {
  id: string;
  organization_id: string;
  knowledge_base_id: string;
  file_name: string;
  mime_type: string;
  storage_path: string;
  file_size: number;
  status: "pending" | "processing" | "ready" | "error";
  extracted_text: string | null;
  error_message: string | null;
  metadata: Json;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type KnowledgeChunkRowShape = {
  id: string;
  organization_id: string;
  knowledge_base_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  search_vector: string;
  embedding: number[] | null;
  metadata: Json;
  created_at: string;
};

type AgentKnowledgeBaseRowShape = {
  organization_id: string;
  agent_id: string;
  knowledge_base_id: string;
  created_at: string;
};

export type Database = MergeDeep<
  DatabaseGenerated,
  {
    public: {
      Tables: {
        organizations: {
          Row: {
            extra: OrganizationExtra | null;
          };
          Insert: {
            extra?: OrganizationExtra;
          };
          Update: {
            extra?: OrganizationExtra;
          };
        };
        organizations_addresses: {
          Row: {
            extra: OrganizationAddressExtra | null;
          };
          Insert: {
            extra?: OrganizationAddressExtra;
          };
          Update: {
            extra?: OrganizationAddressExtra;
          };
        };
        conversations: {
          Row: {
            type: ConversationType | null;
            extra: ConversationExtra | null;
          };
          Insert: {
            type?: ConversationType;
            extra?: ConversationExtra;
          };
          Update: {
            type?: ConversationType;
            extra?: ConversationExtra;
          };
        };
        // There is no row-level discriminant. Who authored a row is
        // `sender_address` (a contact, or null = the account itself);
        // record-only rows carry `content.internal` (see
        // isInternal/isToolTrace). The content union is therefore plain:
        // narrow via content.type/kind, or via the guards.
        messages: {
          Row: {
            content: IncomingMessage | InternalMessage | OutgoingMessage;
            status: IncomingStatus | OutgoingStatus;
          };
          Insert: {
            conversation_id?: string;
            content: IncomingMessage | InternalMessage | OutgoingMessage;
            status?: IncomingStatus | OutgoingStatus;
          };
        };
        contacts_addresses: {
          Row: {
            extra: ContactAddressExtra | null;
          };
          Insert: {
            extra?: ContactAddressExtra;
          };
          Update: {
            extra?: ContactAddressExtra;
          };
        };
        agents: {
          Row: {
            extra: AgentExtra | null;
          };
          Insert: {
            extra?: AgentExtra;
          };
          Update: {
            extra?: AgentExtra;
          };
        };
        knowledge_bases: {
          Row: KnowledgeBaseRowShape;
          Insert: {
            id?: string;
            organization_id: string;
            name: string;
            description?: string | null;
            status?: KnowledgeBaseRowShape["status"];
            created_by?: string | null;
            created_at?: string;
            updated_at?: string;
          };
          Update: Partial<KnowledgeBaseRowShape>;
          Relationships: [];
        };
        knowledge_documents: {
          Row: KnowledgeDocumentRowShape;
          Insert: {
            id?: string;
            organization_id: string;
            knowledge_base_id: string;
            file_name: string;
            mime_type: string;
            storage_path: string;
            file_size?: number;
            status?: KnowledgeDocumentRowShape["status"];
            extracted_text?: string | null;
            error_message?: string | null;
            metadata?: Json;
            created_by?: string | null;
            created_at?: string;
            updated_at?: string;
          };
          Update: Partial<KnowledgeDocumentRowShape>;
          Relationships: [];
        };
        knowledge_chunks: {
          Row: KnowledgeChunkRowShape;
          Insert: {
            organization_id: string;
            knowledge_base_id: string;
            document_id: string;
            chunk_index: number;
            content: string;
            embedding?: number[] | null;
            metadata?: Json;
            id?: string;
            search_vector?: string;
            created_at?: string;
          };
          Update: Partial<KnowledgeChunkRowShape>;
          Relationships: [];
        };
        agent_knowledge_bases: {
          Row: AgentKnowledgeBaseRowShape;
          Insert: AgentKnowledgeBaseRowShape & { created_at?: string };
          Update: Partial<AgentKnowledgeBaseRowShape>;
          Relationships: [];
        };
      };
    };
  }
>;

export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
export type MessageInsert = Database["public"]["Tables"]["messages"]["Insert"];
export type MessageUpdate = Database["public"]["Tables"]["messages"]["Update"];

export type ConversationRow =
  Database["public"]["Tables"]["conversations"]["Row"];

export type OrganizationRow =
  Database["public"]["Tables"]["organizations"]["Row"];

export type ContactAddressRow =
  Database["public"]["Tables"]["contacts_addresses"]["Row"];
export type ContactAddressInsert =
  Database["public"]["Tables"]["contacts_addresses"]["Insert"];

export type AgentRow = Database["public"]["Tables"]["agents"]["Row"];

export type KnowledgeBaseRow =
  Database["public"]["Tables"]["knowledge_bases"]["Row"];
export type KnowledgeDocumentRow =
  Database["public"]["Tables"]["knowledge_documents"]["Row"];
export type KnowledgeChunkRow =
  Database["public"]["Tables"]["knowledge_chunks"]["Row"];
export type AgentKnowledgeBaseRow =
  Database["public"]["Tables"]["agent_knowledge_bases"]["Row"];

export type OrganizationAddressRow =
  Database["public"]["Tables"]["organizations_addresses"]["Row"];

export type ApiKeyRow = Database["public"]["Tables"]["api_keys"]["Row"];
