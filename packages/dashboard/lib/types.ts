export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          id: string
          occurred_at: string
          event_type: Database["public"]["Enums"]["activity_event_type"]
          severity: Database["public"]["Enums"]["activity_severity"]
          summary: string
          links: Json
        }
        Insert: {
          id?: string
          occurred_at?: string
          event_type: Database["public"]["Enums"]["activity_event_type"]
          severity?: Database["public"]["Enums"]["activity_severity"]
          summary: string
          links?: Json
        }
        Update: {
          id?: string
          occurred_at?: string
          event_type?: Database["public"]["Enums"]["activity_event_type"]
          severity?: Database["public"]["Enums"]["activity_severity"]
          summary?: string
          links?: Json
        }
        Relationships: []
      }
      api_keys: {
        Row: {
          created_at: string
          encrypted_value: string
          id: string
          key_type: Database["public"]["Enums"]["key_type"]
          repo_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          encrypted_value: string
          id?: string
          key_type: Database["public"]["Enums"]["key_type"]
          repo_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          encrypted_value?: string
          id?: string
          key_type?: Database["public"]["Enums"]["key_type"]
          repo_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      briefings: {
        Row: {
          id: string
          status_line: string
          changes: Json
          attention: Json
          forecast: string
          signal_snapshot: Json
          generated_at: string
        }
        Insert: {
          id?: string
          status_line: string
          changes?: Json
          attention?: Json
          forecast: string
          signal_snapshot?: Json
          generated_at?: string
        }
        Update: {
          id?: string
          status_line?: string
          changes?: Json
          attention?: Json
          forecast?: string
          signal_snapshot?: Json
          generated_at?: string
        }
        Relationships: []
      }
      cost_events: {
        Row: {
          cost: number
          id: string
          recorded_at: string
          run_id: string
          session_type: Database["public"]["Enums"]["session_type"]
        }
        Insert: {
          cost: number
          id?: string
          recorded_at?: string
          run_id: string
          session_type: Database["public"]["Enums"]["session_type"]
        }
        Update: {
          cost?: number
          id?: string
          recorded_at?: string
          run_id?: string
          session_type?: Database["public"]["Enums"]["session_type"]
        }
        Relationships: [
          {
            foreignKeyName: "cost_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      github_connections: {
        Row: {
          avatar_url: string | null
          connection_type: string
          created_at: string
          created_by: string
          display_name: string
          encrypted_token: string
          github_login: string
          id: string
          scopes: string | null
          status: string
          token_expires_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          connection_type?: string
          created_at?: string
          created_by: string
          display_name: string
          encrypted_token: string
          github_login: string
          id?: string
          scopes?: string | null
          status?: string
          token_expires_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          connection_type?: string
          created_at?: string
          created_by?: string
          display_name?: string
          encrypted_token?: string
          github_login?: string
          id?: string
          scopes?: string | null
          status?: string
          token_expires_at?: string | null
        }
        Relationships: []
      }
      github_orgs: {
        Row: {
          avatar_url: string | null
          connection_id: string
          github_id: number
          id: string
          is_selected: boolean
          login: string
          name: string | null
        }
        Insert: {
          avatar_url?: string | null
          connection_id: string
          github_id: number
          id?: string
          is_selected?: boolean
          login: string
          name?: string | null
        }
        Update: {
          avatar_url?: string | null
          connection_id?: string
          github_id?: number
          id?: string
          is_selected?: boolean
          login?: string
          name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "github_orgs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "github_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_channel_configs: {
        Row: {
          id: string
          channel_type: Database["public"]["Enums"]["notification_channel_type"]
          target: string
          events: Database["public"]["Enums"]["notification_event_kind"][]
        }
        Insert: {
          id?: string
          channel_type: Database["public"]["Enums"]["notification_channel_type"]
          target?: string
          events?: Database["public"]["Enums"]["notification_event_kind"][]
        }
        Update: {
          id?: string
          channel_type?: Database["public"]["Enums"]["notification_channel_type"]
          target?: string
          events?: Database["public"]["Enums"]["notification_event_kind"][]
        }
        Relationships: []
      }
      global_settings: {
        Row: {
          concurrency_limit: number
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          concurrency_limit?: number
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          concurrency_limit?: number
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      invitations: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          invited_by: string | null
          provider_handle: string
          role: Database["public"]["Enums"]["team_role"]
          status: Database["public"]["Enums"]["invite_status"]
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          provider_handle: string
          role?: Database["public"]["Enums"]["team_role"]
          status?: Database["public"]["Enums"]["invite_status"]
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          provider_handle?: string
          role?: Database["public"]["Enums"]["team_role"]
          status?: Database["public"]["Enums"]["invite_status"]
        }
        Relationships: []
      }
      repo_plugins: {
        Row: {
          activated_at: string | null
          active: boolean
          id: string
          plugin_id: string
          recommendation_reason: string | null
          recommended: boolean
          recommended_at: string | null
          repo_id: string
        }
        Insert: {
          activated_at?: string | null
          active?: boolean
          id?: string
          plugin_id: string
          recommendation_reason?: string | null
          recommended?: boolean
          recommended_at?: string | null
          repo_id: string
        }
        Update: {
          activated_at?: string | null
          active?: boolean
          id?: string
          plugin_id?: string
          recommendation_reason?: string | null
          recommended?: boolean
          recommended_at?: string | null
          repo_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repo_plugins_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      repos: {
        Row: {
          budget_limit: number | null
          concurrency_limit: number
          connection_id: string | null
          created_at: string
          credential_error: string | null
          credential_status: string
          deleted_at: string | null
          enabled: boolean
          github_status: string
          id: string
          matrix_status: Database["public"]["Enums"]["matrix_status"]
          name: string
          owner: string
          poll_interval_ms: number | null
          production_branch: string
          staging_branch: string
          updated_at: string
        }
        Insert: {
          budget_limit?: number | null
          concurrency_limit?: number
          connection_id?: string | null
          created_at?: string
          credential_error?: string | null
          credential_status?: string
          deleted_at?: string | null
          enabled?: boolean
          github_status?: string
          id?: string
          matrix_status?: Database["public"]["Enums"]["matrix_status"]
          name: string
          owner: string
          poll_interval_ms?: number | null
          production_branch?: string
          staging_branch?: string
          updated_at?: string
        }
        Update: {
          budget_limit?: number | null
          concurrency_limit?: number
          connection_id?: string | null
          created_at?: string
          credential_error?: string | null
          credential_status?: string
          deleted_at?: string | null
          enabled?: boolean
          github_status?: string
          id?: string
          matrix_status?: Database["public"]["Enums"]["matrix_status"]
          name?: string
          owner?: string
          poll_interval_ms?: number | null
          production_branch?: string
          staging_branch?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "repos_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "github_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          active_plugins: string[]
          completed_at: string | null
          current_phase: string | null
          fix_attempts: number
          id: string
          issue_number: number
          issue_title: string
          outcome: Database["public"]["Enums"]["run_outcome"]
          phases: Json
          pipeline_variant: string
          repo_id: string | null
          repo_name: string
          repo_owner: string
          report: string | null
          started_at: string
          total_cost: number
        }
        Insert: {
          active_plugins?: string[]
          completed_at?: string | null
          current_phase?: string | null
          fix_attempts?: number
          id?: string
          issue_number: number
          issue_title: string
          outcome?: Database["public"]["Enums"]["run_outcome"]
          phases?: Json
          pipeline_variant?: string
          repo_id?: string | null
          repo_name: string
          repo_owner: string
          report?: string | null
          started_at?: string
          total_cost?: number
        }
        Update: {
          active_plugins?: string[]
          completed_at?: string | null
          current_phase?: string | null
          fix_attempts?: number
          id?: string
          issue_number?: number
          issue_title?: string
          outcome?: Database["public"]["Enums"]["run_outcome"]
          phases?: Json
          pipeline_variant?: string
          repo_id?: string | null
          repo_name?: string
          repo_owner?: string
          report?: string | null
          started_at?: string
          total_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "runs_repo_id_fkey"
            columns: ["repo_id"]
            isOneToOne: false
            referencedRelation: "repos"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          granted_at: string
          id: string
          role: Database["public"]["Enums"]["team_role"]
          user_id: string
        }
        Insert: {
          granted_at?: string
          id?: string
          role?: Database["public"]["Enums"]["team_role"]
          user_id: string
        }
        Update: {
          granted_at?: string
          id?: string
          role?: Database["public"]["Enums"]["team_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bootstrap_user_access: {
        Args: { p_provider_handle: string; p_user_id: string }
        Returns: string
      }
      change_member_role: {
        Args: {
          p_member_id: string
          p_new_role: Database["public"]["Enums"]["team_role"]
        }
        Returns: string
      }
      decrypt_api_key: {
        Args: { p_key_type: string; p_repo_id: string }
        Returns: string
      }
      decrypt_github_token: {
        Args: { p_connection_id: string }
        Returns: string
      }
      get_encryption_key: { Args: never; Returns: string }
      is_admin: { Args: never; Returns: boolean }
      is_member: { Args: never; Returns: boolean }
      remove_team_member: { Args: { p_member_id: string }; Returns: string }
      store_github_connection: {
        Args: {
          p_avatar_url: string
          p_connection_type: string
          p_display_name: string
          p_github_login: string
          p_plaintext_token: string
          p_scopes: string
        }
        Returns: string
      }
      upsert_api_key_encrypted: {
        Args: { p_key_type: string; p_plaintext: string; p_repo_id: string }
        Returns: undefined
      }
    }
    Enums: {
      activity_event_type: "state-transition" | "merge" | "error" | "heartbeat" | "completion"
      activity_severity: "info" | "warning" | "error"
      invite_status: "pending" | "accepted"
      key_type: "source-control" | "model-provider" | "webhook-secret"
      matrix_status: "ok" | "degraded" | "failed"
      notification_channel_type: "web-push" | "slack" | "macos" | "webhook"
      notification_event_kind: "attention-required" | "work-completed" | "error" | "digest"
      run_outcome: "in-progress" | "complete" | "stuck" | "escalated" | "failed"
      session_type:
        | "planning"
        | "implementation"
        | "validation"
        | "diagnosis"
        | "fix"
      team_role: "admin" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      activity_event_type: ["state-transition", "merge", "error", "heartbeat", "completion"],
      activity_severity: ["info", "warning", "error"],
      invite_status: ["pending", "accepted"],
      key_type: ["source-control", "model-provider", "webhook-secret"],
      matrix_status: ["ok", "degraded", "failed"],
      notification_channel_type: ["web-push", "slack", "macos", "webhook"],
      notification_event_kind: ["attention-required", "work-completed", "error", "digest"],
      run_outcome: ["in-progress", "complete", "stuck", "escalated", "failed"],
      session_type: [
        "planning",
        "implementation",
        "validation",
        "diagnosis",
        "fix",
      ],
      team_role: ["admin", "viewer"],
    },
  },
} as const
