/**
 * Google Tag Manager dataLayer helpers. Every event name and payload matches the original
 * site so existing GTM triggers keep working.
 */
declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

export const GTM_ID = 'GTM-NMJN82HR';

const push = (event: Record<string, unknown>): void => {
  if (typeof window === 'undefined') return;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push(event);
};

export const analytics = {
  push,
  setUserProperties(props: { threadType: string; renderBackend: string; launchTime: number; hardwareInfo: string }): void {
    push({
      event: 'set_user_properties',
      user_properties: {
        thread_type: props.threadType,
        render_backend: props.renderBackend,
        launch_time: props.launchTime,
        hardware_info: props.hardwareInfo.trim(),
      },
    });
  },
  sectionChange(sectionId: string): void {
    push({ event: 'section_change', event_category: 'scroll', section_id: sectionId });
  },
  sectionTimeSpent(sectionId: string, seconds: number): void {
    push({ event: 'section_time_spent', section_id: sectionId, section_time_spent: seconds.toFixed(2) });
  },
  sectionInteraction(sectionId: string, active: boolean, duration?: number): void {
    if (duration === undefined) return;
    push({ event: 'section_interaction', section_id: sectionId, active, duration: duration.toFixed(2) });
  },
  pageView(path: string, title: string): void {
    push({ event: 'page_view', page_path: path, page_title: title });
  },
  userFps(fps: number): void {
    push({ event: 'user_fps', user_fps: fps });
  },
  buttonClick(name: string, category: string, action = 'click', label = ''): void {
    push({
      event: 'button_click',
      button_name: name,
      button_event_category: category,
      button_click_event_action: action,
      button_click_event_label: label,
    });
  },
  tabNavigation(category: string, tab: string, label = ''): void {
    push({ event: 'tab_navigation', tab_category: category, tab_name: tab, tab_event_label: label });
  },
  pageFullyLoaded(): void {
    push({ event: 'page_fully_loaded' });
  },
  enterButtonClick(): void {
    push({ event: 'enter_button_click' });
  },
};
