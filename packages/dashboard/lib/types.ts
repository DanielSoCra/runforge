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
          id: string
          repo_id: string
          plugin_id: string
          active: boolean
          recommended: boolean
          recommendation_reason: string | null
          recommended_at: string | null
          activated_at: string | null
        }
        Insert: {
          id?: string
          repo_id: string
          plugin_id: string
          active?: boolean
          recommended?: boolean
          recommendation_reason?: string | null
          recommended_at?: string | null
          activated_at?: string | null
        }
        Update: {
          id?: string
          repo_id?: string
          plugin_id?: string
          active?: boolean
          recommended?: boolean
          recommendation_reason?: string | null
          recommended_at?: string | null
          activated_at?: string | null
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
          created_at: string
          deleted_at: string | null
          enabled: boolean
          id: string
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
          created_at?: string
          deleted_at?: string | null
          enabled?: boolean
          id?: string
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
          created_at?: string
          deleted_at?: string | null
          enabled?: boolean
          id?: string
          name?: string
          owner?: string
          poll_interval_ms?: number | null
          production_branch?: string
          staging_branch?: string
          updated_at?: string
        }
        Relationships: []
      }
      runs: {
        Row: {
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
      decrypt_api_key: {
        Args: { p_key_type: string; p_repo_id: string }
        Returns: string
      }
      get_encryption_key: { Args: never; Returns: string }
      is_admin: { Args: never; Returns: boolean }
      is_member: { Args: never; Returns: boolean }
      upsert_api_key_encrypted: {
        Args: { p_key_type: string; p_plaintext: string; p_repo_id: string }
        Returns: undefined
      }
    }
    Enums: {
      invite_status: "pending" | "accepted"
      key_type: "source-control" | "model-provider"
      run_outcome: "in-progress" | "complete" | "stuck" | "escalated"
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
      invite_status: ["pending", "accepted"],
      key_type: ["source-control", "model-provider"],
      run_outcome: ["in-progress", "complete", "stuck", "escalated"],
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
