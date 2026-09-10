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
      admin_audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_user_id: string | null
          created_at: string
          detail: Json
          failure_code: string | null
          id: string
          occurred_at: string
          result: string
          target_email: string | null
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_user_id?: string | null
          created_at?: string
          detail?: Json
          failure_code?: string | null
          id?: string
          occurred_at?: string
          result: string
          target_email?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_user_id?: string | null
          created_at?: string
          detail?: Json
          failure_code?: string | null
          id?: string
          occurred_at?: string
          result?: string
          target_email?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      application_attempts: {
        Row: {
          application_id: string
          attempt_number: number
          created_at: string
          detail: Json
          ended_at: string | null
          executor_id: string | null
          executor_type: string
          failure_class: string | null
          failure_code: string | null
          id: string
          job_id: string
          method: string
          outcome: string | null
          started_at: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          application_id: string
          attempt_number: number
          created_at?: string
          detail?: Json
          ended_at?: string | null
          executor_id?: string | null
          executor_type: string
          failure_class?: string | null
          failure_code?: string | null
          id?: string
          job_id: string
          method: string
          outcome?: string | null
          started_at?: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          application_id?: string
          attempt_number?: number
          created_at?: string
          detail?: Json
          ended_at?: string | null
          executor_id?: string | null
          executor_type?: string
          failure_class?: string | null
          failure_code?: string | null
          id?: string
          job_id?: string
          method?: string
          outcome?: string | null
          started_at?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_attempts_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_attempts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      applications: {
        Row: {
          attempt_count: number
          confirmed_at: string | null
          created_at: string
          executor_id: string | null
          executor_type: string | null
          first_started_at: string | null
          id: string
          job_id: string
          last_attempt_at: string | null
          method: string
          queued_at: string
          status: string
          status_class: string | null
          status_code: string | null
          submitted_at: string | null
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          attempt_count?: number
          confirmed_at?: string | null
          created_at?: string
          executor_id?: string | null
          executor_type?: string | null
          first_started_at?: string | null
          id?: string
          job_id: string
          last_attempt_at?: string | null
          method: string
          queued_at?: string
          status?: string
          status_class?: string | null
          status_code?: string | null
          submitted_at?: string | null
          updated_at?: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          attempt_count?: number
          confirmed_at?: string | null
          created_at?: string
          executor_id?: string | null
          executor_type?: string | null
          first_started_at?: string | null
          id?: string
          job_id?: string
          last_attempt_at?: string | null
          method?: string
          queued_at?: string
          status?: string
          status_class?: string | null
          status_code?: string | null
          submitted_at?: string | null
          updated_at?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "applications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
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
        Relationships: [
          {
            foreignKeyName: "automation_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      automation_tasks: {
        Row: {
          attempt: number
          candidate_assisted: boolean
          correlation_id: string
          created_at: string
          fence_token: number
          finished_at: string | null
          id: string
          idempotency_key: string
          job_id: string | null
          kind: string
          max_attempts: number
          mode: string
          outcome: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt?: number
          candidate_assisted?: boolean
          correlation_id: string
          created_at?: string
          fence_token?: number
          finished_at?: string | null
          id?: string
          idempotency_key: string
          job_id?: string | null
          kind?: string
          max_attempts?: number
          mode: string
          outcome?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt?: number
          candidate_assisted?: boolean
          correlation_id?: string
          created_at?: string
          fence_token?: number
          finished_at?: string | null
          id?: string
          idempotency_key?: string
          job_id?: string | null
          kind?: string
          max_attempts?: number
          mode?: string
          outcome?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_tasks_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_tasks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "certifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "education_entries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      job_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          created_at: string
          detail: Json
          error_category: string | null
          error_code: string | null
          event_type: string
          from_status: string | null
          id: string
          job_id: string
          occurred_at: string
          to_status: string | null
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          created_at?: string
          detail?: Json
          error_category?: string | null
          error_code?: string | null
          event_type: string
          from_status?: string | null
          id?: string
          job_id: string
          occurred_at?: string
          to_status?: string | null
          user_id: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          detail?: Json
          error_category?: string | null
          error_code?: string | null
          event_type?: string
          from_status?: string | null
          id?: string
          job_id?: string
          occurred_at?: string
          to_status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      job_facts: {
        Row: {
          apply_url: string | null
          company_name: string | null
          created_at: string
          date_posted: string | null
          description_text: string | null
          employment_type: string | null
          extraction_reason: string | null
          extraction_status: string
          field_provenance: Json
          id: string
          identifier: string | null
          job_id: string
          location_raw: string | null
          remote_type: string | null
          salary_currency: string | null
          salary_max: number | null
          salary_min: number | null
          salary_period: string | null
          snapshot_id: string
          title: string | null
          updated_at: string
          user_id: string
          valid_through: string | null
        }
        Insert: {
          apply_url?: string | null
          company_name?: string | null
          created_at?: string
          date_posted?: string | null
          description_text?: string | null
          employment_type?: string | null
          extraction_reason?: string | null
          extraction_status: string
          field_provenance?: Json
          id?: string
          identifier?: string | null
          job_id: string
          location_raw?: string | null
          remote_type?: string | null
          salary_currency?: string | null
          salary_max?: number | null
          salary_min?: number | null
          salary_period?: string | null
          snapshot_id: string
          title?: string | null
          updated_at?: string
          user_id: string
          valid_through?: string | null
        }
        Update: {
          apply_url?: string | null
          company_name?: string | null
          created_at?: string
          date_posted?: string | null
          description_text?: string | null
          employment_type?: string | null
          extraction_reason?: string | null
          extraction_status?: string
          field_provenance?: Json
          id?: string
          identifier?: string | null
          job_id?: string
          location_raw?: string | null
          remote_type?: string | null
          salary_currency?: string | null
          salary_max?: number | null
          salary_min?: number | null
          salary_period?: string | null
          snapshot_id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
          valid_through?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_facts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_facts_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "job_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_facts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "job_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      job_snapshots: {
        Row: {
          body: string | null
          byte_size: number
          content_hash: string | null
          content_type: string | null
          created_at: string
          fetched_at: string
          final_url: string | null
          http_status: number | null
          id: string
          job_id: string
          outcome: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          byte_size: number
          content_hash?: string | null
          content_type?: string | null
          created_at?: string
          fetched_at?: string
          final_url?: string | null
          http_status?: number | null
          id?: string
          job_id: string
          outcome: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          byte_size?: number
          content_hash?: string | null
          content_type?: string | null
          created_at?: string
          fetched_at?: string
          final_url?: string | null
          http_status?: number | null
          id?: string
          job_id?: string
          outcome?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_snapshots_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_snapshots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      jobs: {
        Row: {
          ats_vendor: string | null
          canonical_url: string
          created_at: string
          external_job_id: string | null
          id: string
          source: string
          status: string
          status_reason: string | null
          submitted_url: string
          updated_at: string
          url_fingerprint: string | null
          user_id: string
        }
        Insert: {
          ats_vendor?: string | null
          canonical_url: string
          created_at?: string
          external_job_id?: string | null
          id?: string
          source: string
          status?: string
          status_reason?: string | null
          submitted_url: string
          updated_at?: string
          url_fingerprint?: string | null
          user_id: string
        }
        Update: {
          ats_vendor?: string | null
          canonical_url?: string
          created_at?: string
          external_job_id?: string | null
          id?: string
          source?: string
          status?: string
          status_reason?: string | null
          submitted_url?: string
          updated_at?: string
          url_fingerprint?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "languages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      profile_drafts: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          input: Json
          profile_version: string
          result: Json | null
          resume_import_id: string | null
          reviewed_at: string | null
          status: string
          task_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          input: Json
          profile_version: string
          result?: Json | null
          resume_import_id?: string | null
          reviewed_at?: string | null
          status?: string
          task_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          input?: Json
          profile_version?: string
          result?: Json | null
          resume_import_id?: string | null
          reviewed_at?: string | null
          status?: string
          task_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_drafts_resume_import_id_fkey"
            columns: ["resume_import_id"]
            isOneToOne: false
            referencedRelation: "resume_imports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_drafts_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "automation_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_drafts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "projects_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      provider_usage: {
        Row: {
          attempts: number
          completion_tokens: number | null
          correlation_id: string | null
          cost_usd: number | null
          created_at: string
          failure_class: string | null
          failure_code: string | null
          id: string
          latency_ms: number
          model: string
          operation: string
          prompt_tokens: number | null
          provider: string
          provider_request_id: string | null
          status: string
          total_tokens: number | null
          user_id: string | null
        }
        Insert: {
          attempts: number
          completion_tokens?: number | null
          correlation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          failure_class?: string | null
          failure_code?: string | null
          id?: string
          latency_ms: number
          model: string
          operation: string
          prompt_tokens?: number | null
          provider: string
          provider_request_id?: string | null
          status: string
          total_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          attempts?: number
          completion_tokens?: number | null
          correlation_id?: string | null
          cost_usd?: number | null
          created_at?: string
          failure_class?: string | null
          failure_code?: string | null
          id?: string
          latency_ms?: number
          model?: string
          operation?: string
          prompt_tokens?: number | null
          provider?: string
          provider_request_id?: string | null
          status?: string
          total_tokens?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provider_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      resume_imports: {
        Row: {
          confirmed_at: string | null
          created_at: string
          extracted: Json | null
          failure_class: string | null
          failure_code: string | null
          file_name: string | null
          file_size_bytes: number | null
          id: string
          model: string | null
          parsed_at: string | null
          provider_failure_code: string | null
          provider_failure_detail: string | null
          source_kind: string
          status: string
          storage_path: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          confirmed_at?: string | null
          created_at?: string
          extracted?: Json | null
          failure_class?: string | null
          failure_code?: string | null
          file_name?: string | null
          file_size_bytes?: number | null
          id?: string
          model?: string | null
          parsed_at?: string | null
          provider_failure_code?: string | null
          provider_failure_detail?: string | null
          source_kind?: string
          status?: string
          storage_path?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          confirmed_at?: string | null
          created_at?: string
          extracted?: Json | null
          failure_class?: string | null
          failure_code?: string | null
          file_name?: string | null
          file_size_bytes?: number | null
          id?: string
          model?: string | null
          parsed_at?: string | null
          provider_failure_code?: string | null
          provider_failure_detail?: string | null
          source_kind?: string
          status?: string
          storage_path?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "resume_imports_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "skills_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      task_leases: {
        Row: {
          acquired_at: string
          created_at: string
          expires_at: string
          fence_token: number
          id: string
          release_reason: string | null
          released_at: string | null
          slot_id: string
          task_id: string
          user_id: string
        }
        Insert: {
          acquired_at?: string
          created_at?: string
          expires_at: string
          fence_token: number
          id?: string
          release_reason?: string | null
          released_at?: string | null
          slot_id: string
          task_id: string
          user_id: string
        }
        Update: {
          acquired_at?: string
          created_at?: string
          expires_at?: string
          fence_token?: number
          id?: string
          release_reason?: string | null
          released_at?: string | null
          slot_id?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_leases_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "worker_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_leases_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "automation_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_leases_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_access: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          reason: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          reason?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          reason?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_access_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          granted_at: string
          granted_by: string | null
          note: string | null
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          role: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "user_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "verified_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "work_authorizations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
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
        Relationships: [
          {
            foreignKeyName: "work_experiences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      worker_credentials: {
        Row: {
          audience: string
          created_at: string
          expires_at: string
          id: string
          issued_at: string
          last_used_at: string | null
          revoked_at: string | null
          revoked_reason: string | null
          scope: string
          slot_id: string | null
          supervisor_id: string
          token_hash: string
          user_id: string
        }
        Insert: {
          audience?: string
          created_at?: string
          expires_at: string
          id?: string
          issued_at?: string
          last_used_at?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          scope?: string
          slot_id?: string | null
          supervisor_id: string
          token_hash: string
          user_id: string
        }
        Update: {
          audience?: string
          created_at?: string
          expires_at?: string
          id?: string
          issued_at?: string
          last_used_at?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          scope?: string
          slot_id?: string | null
          supervisor_id?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_credentials_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "worker_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_credentials_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "worker_supervisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_credentials_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      worker_events: {
        Row: {
          created_at: string
          detail: Json
          id: string
          kind: string
          occurred_at: string
          slot_id: string | null
          supervisor_id: string | null
          task_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: string
          kind: string
          occurred_at?: string
          slot_id?: string | null
          supervisor_id?: string | null
          task_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: string
          kind?: string
          occurred_at?: string
          slot_id?: string | null
          supervisor_id?: string | null
          task_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_events_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "worker_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_events_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "worker_supervisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "automation_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      worker_pairings: {
        Row: {
          attempts: number
          created_at: string
          expires_at: string
          id: string
          redeemed_at: string | null
          redeemed_supervisor_id: string | null
          revoked_at: string | null
          secret_hash: string
          user_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          expires_at: string
          id?: string
          redeemed_at?: string | null
          redeemed_supervisor_id?: string | null
          revoked_at?: string | null
          secret_hash: string
          user_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          expires_at?: string
          id?: string
          redeemed_at?: string | null
          redeemed_supervisor_id?: string | null
          revoked_at?: string | null
          secret_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_pairings_redeemed_supervisor_id_fkey"
            columns: ["redeemed_supervisor_id"]
            isOneToOne: false
            referencedRelation: "worker_supervisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_pairings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      worker_slots: {
        Row: {
          browser_context_id: string
          capabilities: string[]
          claude_session: string
          created_at: string
          employer_session: string
          heartbeat_sequence: number
          id: string
          last_heartbeat_at: string | null
          pause_reason: string | null
          readiness: string
          slot_index: number
          stop_reason: string | null
          supervisor_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          browser_context_id: string
          capabilities?: string[]
          claude_session?: string
          created_at?: string
          employer_session?: string
          heartbeat_sequence?: number
          id?: string
          last_heartbeat_at?: string | null
          pause_reason?: string | null
          readiness?: string
          slot_index: number
          stop_reason?: string | null
          supervisor_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          browser_context_id?: string
          capabilities?: string[]
          claude_session?: string
          created_at?: string
          employer_session?: string
          heartbeat_sequence?: number
          id?: string
          last_heartbeat_at?: string | null
          pause_reason?: string | null
          readiness?: string
          slot_index?: number
          stop_reason?: string | null
          supervisor_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_slots_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "worker_supervisors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_slots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      worker_supervisors: {
        Row: {
          agent_version: string
          created_at: string
          declared_slots: number
          heartbeat_sequence: number
          id: string
          last_heartbeat_at: string | null
          lifecycle: string
          platform: string
          revoked_at: string | null
          revoked_reason: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_version: string
          created_at?: string
          declared_slots?: number
          heartbeat_sequence?: number
          id?: string
          last_heartbeat_at?: string | null
          lifecycle?: string
          platform: string
          revoked_at?: string | null
          revoked_reason?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_version?: string
          created_at?: string
          declared_slots?: number
          heartbeat_sequence?: number
          id?: string
          last_heartbeat_at?: string | null
          lifecycle?: string
          platform?: string
          revoked_at?: string | null
          revoked_reason?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_supervisors_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "admin_user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
    }
    Views: {
      admin_platform_stats: {
        Row: {
          admin_actions_7d: number | null
          admin_actions_failed_7d: number | null
          applications_automated: number | null
          applications_failed: number | null
          applications_manual: number | null
          applications_needs_intervention: number | null
          applications_pending: number | null
          applications_succeeded: number | null
          applications_total: number | null
          bid_bot_attempts: number | null
          bid_bot_attempts_submitted: number | null
          bid_bot_failed: number | null
          bid_bot_succeeded: number | null
          bid_bot_total: number | null
          jobs_extracted: number | null
          jobs_new_7d: number | null
          jobs_parked: number | null
          jobs_total: number | null
          users_active_30d: number | null
          users_admin: number | null
          users_approved: number | null
          users_new_30d: number | null
          users_new_7d: number | null
          users_pending_approval: number | null
          users_pending_confirmation: number | null
          users_rejected: number | null
          users_total: number | null
        }
        Relationships: []
      }
      admin_user_directory: {
        Row: {
          access_decided_at: string | null
          access_decided_by: string | null
          access_reason: string | null
          access_status: string | null
          account_status: string | null
          applications_failed: number | null
          applications_pending: number | null
          applications_succeeded: number | null
          applications_total: number | null
          automation_total: number | null
          banned_until: string | null
          bid_bot_attempts: number | null
          bid_bot_succeeded: number | null
          bid_bot_total: number | null
          city: string | null
          contact_email: string | null
          country_code: string | null
          deleted_at: string | null
          display_name: string | null
          email: string | null
          email_confirmed_at: string | null
          invited_at: string | null
          is_anonymous: boolean | null
          is_automation_enabled: boolean | null
          jobs_total: number | null
          last_activity_at: string | null
          last_application_at: string | null
          last_job_at: string | null
          last_sign_in_at: string | null
          manual_total: number | null
          onboarding_completed_at: string | null
          preferred_name: string | null
          registered_at: string | null
          role: string | null
          role_granted_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      application_stats_by_user: {
        Row: {
          applications_cancelled: number | null
          applications_confirmed: number | null
          applications_duplicate: number | null
          applications_failed: number | null
          applications_needs_intervention: number | null
          applications_pending: number | null
          applications_skipped: number | null
          applications_succeeded: number | null
          applications_total: number | null
          attempts_failed: number | null
          attempts_total: number | null
          automated_total: number | null
          automation_total: number | null
          bid_bot_attempts: number | null
          bid_bot_attempts_submitted: number | null
          bid_bot_failed: number | null
          bid_bot_succeeded: number | null
          bid_bot_total: number | null
          external_total: number | null
          last_application_at: string | null
          last_attempt_at: string | null
          last_submitted_at: string | null
          manual_total: number | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      is_blank_or_invisible: { Args: { value: string }; Returns: boolean }
      jsonb_links_ok: {
        Args: {
          links: Json
          max_items: number
          max_label: number
          max_url: number
        }
        Returns: boolean
      }
      text_array_matches: {
        Args: { arr: string[]; pattern: string }
        Returns: boolean
      }
      text_array_ok: {
        Args: { arr: string[]; max_items: number; max_len: number }
        Returns: boolean
      }
      worker_claim_task: {
        Args: { p_credential_id: string; p_token_hash: string }
        Returns: {
          claimed_fence: number
          claimed_input: Json
          claimed_kind: string
          claimed_lease_expires_at: string
          claimed_lease_id: string
          claimed_task_id: string
          ok: boolean
          reason: string
        }[]
      }
      worker_record_heartbeat: {
        Args: {
          p_credential_id: string
          p_lifecycle: string
          p_readiness: string
          p_reason?: string
          p_sequence: number
          p_token_hash: string
        }
        Returns: {
          applied: boolean
          ok: boolean
          reason: string
        }[]
      }
      worker_redeem_pairing: {
        Args: {
          p_agent_version: string
          p_credential_expires_at: string
          p_credential_id: string
          p_platform: string
          p_secret_hash: string
          p_token_hash: string
        }
        Returns: {
          new_slot_id: string
          new_supervisor_id: string
          ok: boolean
          reason: string
        }[]
      }
      worker_renew_lease: {
        Args: {
          p_credential_id: string
          p_fence_token: number
          p_token_hash: string
        }
        Returns: {
          ok: boolean
          reason: string
          renewed_expires_at: string
        }[]
      }
      worker_report_task: {
        Args: {
          p_credential_id: string
          p_disposition: string
          p_fence_token: number
          p_reason?: string
          p_token_hash: string
        }
        Returns: {
          ok: boolean
          reason: string
        }[]
      }
      worker_resolve_credential: {
        Args: { p_credential_id: string; p_token_hash: string }
        Returns: {
          cred_slot_id: string
          cred_supervisor_id: string
          cred_user_id: string
          ok: boolean
          reason: string
        }[]
      }
      worker_revoke_supervisor: {
        Args: never
        Returns: {
          ok: boolean
          reason: string
          revoked_count: number
        }[]
      }
      worker_submit_profile_draft: {
        Args: {
          p_credential_id: string
          p_draft: Json
          p_fence_token: number
          p_token_hash: string
        }
        Returns: {
          ok: boolean
          reason: string
        }[]
      }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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

