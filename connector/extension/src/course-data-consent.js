export const COURSE_DATA_CONSENT_KEY = "morrowCourseDataConsent";
export const COURSE_DATA_CONSENT_VALUE = "morrow.course-data-consent.v1";

export function hasCourseDataConsent(value) {
  return value === COURSE_DATA_CONSENT_VALUE;
}
