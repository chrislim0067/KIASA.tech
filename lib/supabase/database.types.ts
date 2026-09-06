export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      automation_settings: {
        Row: {
          absolute_min_salary: number | null
          absolute_salary_currency: string | null
          absolute_salary_period: string | null
          allow_cover_letter_generation: boolean
          allow_resume_tailoring: boolean
          allowed_country_codes: string[]
          allowed_titles: string[]
          always_require_approval_categories: string[]
          created_at: string
          excluded_companies: string[]
          excluded_industries: string[]
          excluded_locations: string[]
          excluded_titles: string[]
          extra_stop_conditions: Json
          is_automation_enabled: boolean
          max_applications_per_day: number
          min_match_score: number
          stop_on_application_fee: boolean
          stop_on_assessment: boolean
          stop_on_captcha: boolean
          stop_on_external_contact_request: boolean
          stop_on_legal_attestation: boolean
          stop_on_mfa: boolean
          stop_on_sensitive_question: boolean
          stop_on_unknown_question: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          absolute_min_salary?: number | null
          absolute_salary_currency?: string | null
          absolute_salary_period?: string | null
          allow_cover_letter_generation?: boolean
          allow_resume_tailoring?: boolean
          allowed_country_codes?: string[]
          allowed_titles?: string[]
          always_require_approval_categories?: string[]
          created_at?: string
          excluded_companies?: string[]
          excluded_industries?: string[]
          excluded_locations?: string[]
          excluded_titles?: string[]
          extra_stop_conditions?: Json
          is_automation_enabled?: boolean
          max_applications_per_day?: number
          min_match_score?: number
          stop_on_application_fee?: boolean
          stop_on_assessment?: boolean
          stop_on_captcha?: boolean
          stop_on_external_contact_request?: boolean
          stop_on_legal_attestation?: boolean
          stop_on_mfa?: boolean
          stop_on_sensitive_question?: boolean
          stop_on_unknown_question?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          absolute_min_salary?: number | null
          absolute_salary_currency?: string | null
          absolute_salary_period?: string | null
          allow_cover_letter_generation?: boolean
          allow_resume_tailoring?: boolean
          allowed_country_codes?: string[]
          allowed_titles?: string[]
          always_require_approval_categories?: string[]
          created_at?: string
          excluded_companies?: string[]
          excluded_industries?: string[]
          excluded_locations?: string[]
          excluded_titles?: string[]
          extra_stop_conditions?: Json
          is_automation_enabled?: boolean
          max_applications_per_day?: number
          min_match_score?: number
          stop_on_application_fee?: boolean
          stop_on_assessment?: boolean
          stop_on_captcha?: boolean
          stop_on_external_contact_request?: boolean
          stop_on_legal_attestation?: boolean
          stop_on_mfa?: boolean
          stop_on_sensitive_question?: boolean
          stop_on_unknown_question?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      certifications: {
        Row: {
          created_at: string
          credential_id: string | null
          credential_url: string | null
          does_not_expire: boolean
          expiry_date: string | null
          id: string
          issue_date: string | null
          issuing_organization: string | null
          name: string
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credential_id?: string | null
          credential_url?: string | null
          does_not_expire?: boolean
          expiry_date?: string | null
          id?: string
          issue_date?: string | null
          issuing_organization?: string | null
          name: string
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credential_id?: string | null
          credential_url?: string | null
          does_not_expire?: boolean
          expiry_date?: string | null
          id?: string
          issue_date?: string | null
          issuing_organization?: string | null
          name?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      education_entries: {
        Row: {
          achievements: string[]
          created_at: string
          degree: string | null
          description: string | null
          end_date: string | null
          field_of_study: string | null
          grade: string | null
          id: string
          institution_name: string
          is_current: boolean
          location_city: string | null
          location_country_code: string | null
          sort_order: number
          start_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          achievements?: string[]
          created_at?: string
          degree?: string | null
          description?: string | null
          end_date?: string | null
          field_of_study?: string | null
          grade?: string | null
          id?: string
          institution_name: string
          is_current?: boolean
          location_city?: string | null
          location_country_code?: string | null
          sort_order?: number
          start_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          achievements?: string[]
          created_at?: string
          degree?: string | null
          description?: string | null
          end_date?: string | null
          field_of_study?: string | null
          grade?: string | null
          id?: string
          institution_name?: string
          is_current?: boolean
          location_city?: string | null
          location_country_code?: string | null
          sort_order?: number
          start_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      job_preferences: {
        Row: {
          created_at: string
          desired_experience_level: string | null
          desired_locations: string[]
          desired_min_salary: number | null
          desired_titles: string[]
          employment_types: string[]
          preferred_industries: string[]
          salary_currency: string | null
          salary_period: string | null
          travel_willingness: string | null
          updated_at: string
          user_id: string
          willing_to_relocate: boolean | null
          work_modes: string[]
        }
        Insert: {
          created_at?: string
          desired_experience_level?: string | null
          desired_locations?: string[]
          desired_min_salary?: number | null
          desired_titles?: string[]
          employment_types?: string[]
          preferred_industries?: string[]
          salary_currency?: string | null
          salary_period?: string | null
          travel_willingness?: string | null
          updated_at?: string
          user_id: string
          willing_to_relocate?: boolean | null
          work_modes?: string[]
        }
        Update: {
          created_at?: string
          desired_experience_level?: string | null
          desired_locations?: string[]
          desired_min_salary?: number | null
          desired_titles?: string[]
          employment_types?: string[]
          preferred_industries?: string[]
          salary_currency?: string | null
          salary_period?: string | null
          travel_willingness?: string | null
          updated_at?: string
          user_id?: string
          willing_to_relocate?: boolean | null
          work_modes?: string[]
        }
        Relationships: []
      }
      languages: {
        Row: {
          created_at: string
          id: string
          language_code: string
          language_name: string | null
          proficiency: string
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          language_code: string
          language_name?: string | null
          proficiency: string
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          language_code?: string
          language_name?: string | null
          proficiency?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          address_line_1: string | null
          address_line_2: string | null
          city: string | null
          contact_email: string | null
          country_code: string | null
          created_at: string
          github_url: string | null
          legal_first_name: string | null
          legal_last_name: string | null
          legal_middle_name: string | null
          legal_suffix: string | null
          linkedin_url: string | null
          onboarding_completed_at: string | null
          other_links: Json
          phone_e164: string | null
          portfolio_url: string | null
          postal_code: string | null
          preferred_name: string | null
          state_region: string | null
          timezone: string | null
          updated_at: string
          user_id: string
          website_url: string | null
        }
        Insert: {
          address_line_1?: string | null
          address_line_2?: string | null
          city?: string | null
          contact_email?: string | null
          country_code?: string | null
          created_at?: string
          github_url?: string | null
          legal_first_name?: string | null
          legal_last_name?: string | null
          legal_middle_name?: string | null
          legal_suffix?: string | null
          linkedin_url?: string | null
          onboarding_completed_at?: string | null
          other_links?: Json
          phone_e164?: string | null
          portfolio_url?: string | null
          postal_code?: string | null
          preferred_name?: string | null
          state_region?: string | null
          timezone?: string | null
          updated_at?: string
          user_id: string
          website_url?: string | null
        }
        Update: {
          address_line_1?: string | null
          address_line_2?: string | null
          city?: string | null
          contact_email?: string | null
          country_code?: string | null
          created_at?: string
          github_url?: string | null
          legal_first_name?: string | null
          legal_last_name?: string | null
          legal_middle_name?: string | null
          legal_suffix?: string | null
          linkedin_url?: string | null
          onboarding_completed_at?: string | null
          other_links?: Json
          phone_e164?: string | null
          portfolio_url?: string | null
          postal_code?: string | null
          preferred_name?: string | null
          state_region?: string | null
          timezone?: string | null
          updated_at?: string
          user_id?: string
          website_url?: string | null
        }
        Relationships: []
      }
      projects: {
        Row: {
          achievements: string[]
          created_at: string
          description: string | null
          end_date: string | null
          id: string
          is_ongoing: boolean
          name: string
          repository_url: string | null
          role: string | null
          sort_order: number
          start_date: string | null
          technologies: string[]
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          achievements?: string[]
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          is_ongoing?: boolean
          name: string
          repository_url?: string | null
          role?: string | null
          sort_order?: number
          start_date?: string | null
          technologies?: string[]
          updated_at?: string
          url?: string | null
          user_id: string
        }
        Update: {
          achievements?: string[]
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          is_ongoing?: boolean
          name?: string
          repository_url?: string | null
          role?: string | null
          sort_order?: number
          start_date?: string | null
          technologies?: string[]
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      skills: {
        Row: {
          category: string | null
          created_at: string
          id: string
          last_used_year: number | null
          name: string
          proficiency: string | null
          sort_order: number
          updated_at: string
          user_id: string
          years_experience: number | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          last_used_year?: number | null
          name: string
          proficiency?: string | null
          sort_order?: number
          updated_at?: string
          user_id: string
          years_experience?: number | null
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          last_used_year?: number | null
          name?: string
          proficiency?: string | null
          sort_order?: number
          updated_at?: string
          user_id?: string
          years_experience?: number | null
        }
        Relationships: []
      }
      verified_answers: {
        Row: {
          answer_structured: Json | null
          answer_text: string | null
          answer_type: string
          created_at: string
          id: string
          is_locked: boolean
          is_verified: boolean
          last_used_at: string | null
          question_category: string | null
          question_key: string
          question_text: string | null
          requires_human_approval: boolean | null
          sensitivity: string
          source: string
          times_used: number
          updated_at: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          answer_structured?: Json | null
          answer_text?: string | null
          answer_type?: string
          created_at?: string
          id?: string
          is_locked?: boolean
          is_verified?: boolean
          last_used_at?: string | null
          question_category?: string | null
          question_key: string
          question_text?: string | null
          requires_human_approval?: boolean | null
          sensitivity?: string
          source: string
          times_used?: number
          updated_at?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          answer_structured?: Json | null
          answer_text?: string | null
          answer_type?: string
          created_at?: string
          id?: string
          is_locked?: boolean
          is_verified?: boolean
          last_used_at?: string | null
          question_category?: string | null
          question_key?: string
          question_text?: string | null
          requires_human_approval?: boolean | null
          sensitivity?: string
          source?: string
          times_used?: number
          updated_at?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      work_authorizations: {
        Row: {
          basis: string | null
          country_code: string
          created_at: string
          id: string
          is_authorized: boolean
          sponsorship_required_future: boolean
          sponsorship_required_now: boolean
          updated_at: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          basis?: string | null
          country_code: string
          created_at?: string
          id?: string
          is_authorized: boolean
          sponsorship_required_future: boolean
          sponsorship_required_now: boolean
          updated_at?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          basis?: string | null
          country_code?: string
          created_at?: string
          id?: string
          is_authorized?: boolean
          sponsorship_required_future?: boolean
          sponsorship_required_now?: boolean
          updated_at?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      work_experiences: {
        Row: {
          achievements: string[]
          company_name: string
          created_at: string
          description: string | null
          employment_type: string | null
          end_date: string | null
          id: string
          is_current: boolean
          job_title: string
          location_city: string | null
          location_country_code: string | null
          sort_order: number
          start_date: string | null
          updated_at: string
          user_id: string
          work_mode: string | null
        }
        Insert: {
          achievements?: string[]
          company_name: string
          created_at?: string
          description?: string | null
          employment_type?: string | null
          end_date?: string | null
          id?: string
          is_current?: boolean
          job_title: string
          location_city?: string | null
          location_country_code?: string | null
          sort_order?: number
          start_date?: string | null
          updated_at?: string
          user_id: string
          work_mode?: string | null
        }
        Update: {
          achievements?: string[]
          company_name?: string
          created_at?: string
          description?: string | null
          employment_type?: string | null
          end_date?: string | null
          id?: string
          is_current?: boolean
          job_title?: string
          location_city?: string | null
          location_country_code?: string | null
          sort_order?: number
          start_date?: string | null
          updated_at?: string
          user_id?: string
          work_mode?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      text_array_matches: {
        Args: { arr: string[]; pattern: string }
        Returns: boolean
      }
      text_array_no_blanks: { Args: { arr: string[] }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const

