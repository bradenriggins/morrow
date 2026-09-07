import { describe, expect, it } from "vitest";
import {
  MOODLE_COURSE_PARTICIPANTS_SCHEMA,
  MOODLE_ENROLMENT_METHODS_SCHEMA,
  MOODLE_PARTICIPANT_ENROLMENT_SCHEMA,
  projectMoodleCourseParticipantsSource,
  projectMoodleEnrolmentMethods,
  projectMoodleParticipantEnrolmentSource,
  projectPublicMoodleCourseParticipants,
  projectPublicMoodleParticipantEnrolment,
} from "../src/moodle-participants.js";

const CAPABILITIES = ["moodle/course:viewparticipants", "moodle/course:enrolreview"];
const TOKENS = [
  "learner_0f2b7c41-9a3d-4e51-8b6c-1d2e3f4a5b6c",
  "learner_1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
];
const TABLE_PROOF = {
  method: "core_table_get_dynamic_table_content",
  complete: true,
  required_capabilities: CAPABILITIES,
  participant_limit: 500,
  page_size: 100,
  page_request_limit: 5,
  page_request_count: 1,
};

const participantsBody = {
  schema: MOODLE_COURSE_PARTICIPANTS_SCHEMA,
  provider: "moodle",
  course_id: 2,
  participant_count: 2,
  proof: { ...TABLE_PROOF, total_rows: 2 },
};
const sourceRows = [
  { user_id: "7", roles: ["Student"], enrolment_methods: ["Manual enrolments", "Self enrolment (Student)"] },
  { user_id: "3", roles: ["Teacher"], enrolment_methods: ["Manual enrolments"] },
];
const publicRows = sourceRows.map((row, index) => ({
  learnerToken: TOKENS[index]!,
  roles: row.roles,
  enrolment_methods: row.enrolment_methods,
}));

const methods = {
  schema: MOODLE_ENROLMENT_METHODS_SCHEMA,
  provider: "moodle",
  course_id: 2,
  method_count: 2,
  methods: [
    { name: "Manual enrolments", enabled: true, participant_count: 3 },
    { name: "Self enrolment (Student)", enabled: false, participant_count: 0 },
  ],
  proof: {
    method: "native_enrol_instances_page",
    complete: true,
    required_capabilities: CAPABILITIES,
    method_limit: 100,
  },
};

const enrolmentBody = {
  schema: MOODLE_PARTICIPANT_ENROLMENT_SCHEMA,
  provider: "moodle",
  course_id: 2,
  enrolment_count: 2,
  enrolments: [
    { method: "Manual enrolments", status: "Active", start: "2026-01-01T00:00:00.000Z", end: null },
    { method: "Self enrolment (Student)", status: "Suspended", start: null, end: "2027-01-01T00:00:00.000Z" },
  ],
  proof: TABLE_PROOF,
};

describe("Moodle participant list projection", () => {
  it("keeps the user ID at the source boundary and the token at the public one", () => {
    const source = projectMoodleCourseParticipantsSource({ ...participantsBody, participants: sourceRows }, { courseId: 2 });
    expect(source.participants).toEqual(sourceRows);
    expect(source.proof.required_capabilities).toEqual(CAPABILITIES);

    const projected = projectPublicMoodleCourseParticipants({ ...participantsBody, participants: publicRows }, { courseId: 2 });
    expect(projected.participants).toEqual(publicRows);
    expect(JSON.stringify(projected)).not.toContain("user_id");
  });

  it("refuses a public list that still carries a Moodle user ID, and a source list that carries a token", () => {
    expect(() => projectPublicMoodleCourseParticipants({
      ...participantsBody,
      participants: [{ ...publicRows[0], user_id: "7" }, publicRows[1]],
    }, { courseId: 2 })).toThrow("moodle_course_participants_invalid");
    expect(() => projectMoodleCourseParticipantsSource({
      ...participantsBody,
      participants: [{ learnerToken: TOKENS[0], roles: ["Student"], enrolment_methods: ["Manual enrolments"] }],
      participant_count: 1,
      proof: { ...TABLE_PROOF, total_rows: 1 },
    }, { courseId: 2 })).toThrow("moodle_course_participants_invalid");
  });

  it("refuses a list that does not match the course, the count, or the table's own total", () => {
    const rows = { ...participantsBody, participants: sourceRows };
    expect(() => projectMoodleCourseParticipantsSource(rows, { courseId: 5 })).toThrow("moodle_course_participants_invalid");
    expect(() => projectMoodleCourseParticipantsSource({ ...rows, participant_count: 3 }, { courseId: 2 }))
      .toThrow("moodle_course_participants_invalid");
    // A table that holds more rows than the returned list is an incomplete
    // read; it must never project as the whole course.
    expect(() => projectMoodleCourseParticipantsSource({ ...rows, proof: { ...TABLE_PROOF, total_rows: 9 } }, { courseId: 2 }))
      .toThrow("moodle_course_participants_invalid");
  });

  it("refuses a duplicated identity and an enrolment column the read could not see", () => {
    expect(() => projectMoodleCourseParticipantsSource({
      ...participantsBody,
      participants: [sourceRows[0], { ...sourceRows[1], user_id: "7" }],
    }, { courseId: 2 })).toThrow("moodle_course_participants_invalid");
    expect(() => projectPublicMoodleCourseParticipants({
      ...participantsBody,
      participants: [publicRows[0], { ...publicRows[1], learnerToken: TOKENS[0] }],
    }, { courseId: 2 })).toThrow("moodle_course_participants_invalid");
    expect(() => projectMoodleCourseParticipantsSource({
      ...participantsBody,
      participant_count: 1,
      participants: [{ user_id: "7", roles: ["Student"], enrolment_methods: [] }],
      proof: { ...TABLE_PROOF, total_rows: 1 },
    }, { courseId: 2 })).toThrow("moodle_course_participants_invalid");
  });

  it("refuses a row that carries a name, and a capability list that is not the required pair", () => {
    expect(() => projectMoodleCourseParticipantsSource({
      ...participantsBody,
      participant_count: 1,
      participants: [{ ...sourceRows[0], name: "Jane Moodle" }],
      proof: { ...TABLE_PROOF, total_rows: 1 },
    }, { courseId: 2 })).toThrow("moodle_course_participants_invalid");
    expect(() => projectMoodleCourseParticipantsSource({
      ...participantsBody,
      participants: sourceRows,
      proof: { ...TABLE_PROOF, total_rows: 2, required_capabilities: ["moodle/course:viewparticipants"] },
    }, { courseId: 2 })).toThrow("moodle_course_participants_invalid");
  });
});

describe("Moodle enrolment-method projection", () => {
  it("returns one row per method with its enabled state and user count", () => {
    expect(projectMoodleEnrolmentMethods(methods, { courseId: 2 })).toEqual(methods);
  });

  it("refuses a count that does not match, a missing enabled state, and a stray field", () => {
    expect(() => projectMoodleEnrolmentMethods({ ...methods, method_count: 3 }, { courseId: 2 }))
      .toThrow("moodle_enrolment_methods_invalid");
    expect(() => projectMoodleEnrolmentMethods({
      ...methods,
      method_count: 1,
      methods: [{ name: "Manual enrolments", participant_count: 3 }],
    }, { courseId: 2 })).toThrow("moodle_enrolment_methods_invalid");
    expect(() => projectMoodleEnrolmentMethods({
      ...methods,
      method_count: 1,
      methods: [{ name: "Manual enrolments", enabled: true, participant_count: 3, user_id: "7" }],
    }, { courseId: 2 })).toThrow("moodle_enrolment_methods_invalid");
  });
});

describe("Moodle participant enrolment projection", () => {
  it("keeps one requested identity at the source boundary and a token at the public one", () => {
    const source = projectMoodleParticipantEnrolmentSource({ ...enrolmentBody, learner: { user_id: "7" } }, { courseId: 2, userId: 7 });
    expect(source.learner).toEqual({ user_id: "7" });
    expect(source.enrolments[0]).toEqual({ method: "Manual enrolments", status: "Active", start: "2026-01-01T00:00:00.000Z", end: null });

    const projected = projectPublicMoodleParticipantEnrolment({ ...enrolmentBody, learner: { learnerToken: TOKENS[0] } }, { courseId: 2 });
    expect(projected.learner).toEqual({ learnerToken: TOKENS[0] });
    expect(JSON.stringify(projected)).not.toContain("user_id");
  });

  it("refuses a record for a user other than the requested one", () => {
    expect(() => projectMoodleParticipantEnrolmentSource({ ...enrolmentBody, learner: { user_id: "9" } }, { courseId: 2, userId: 7 }))
      .toThrow("moodle_participant_enrolment_invalid");
  });

  it("refuses an empty record, a date that is not an exact instant, and an end before its start", () => {
    expect(() => projectMoodleParticipantEnrolmentSource({
      ...enrolmentBody, enrolment_count: 0, enrolments: [], learner: { user_id: "7" },
    }, { courseId: 2, userId: 7 })).toThrow("moodle_participant_enrolment_invalid");
    expect(() => projectMoodleParticipantEnrolmentSource({
      ...enrolmentBody,
      enrolment_count: 1,
      enrolments: [{ method: "Manual enrolments", status: "Active", start: "2026-01-01", end: null }],
      learner: { user_id: "7" },
    }, { courseId: 2, userId: 7 })).toThrow("moodle_participant_enrolment_invalid");
    expect(() => projectMoodleParticipantEnrolmentSource({
      ...enrolmentBody,
      enrolment_count: 1,
      enrolments: [{ method: "Manual enrolments", status: "Active", start: "2027-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" }],
      learner: { user_id: "7" },
    }, { courseId: 2, userId: 7 })).toThrow("moodle_participant_enrolment_invalid");
  });

  it("refuses a status that carries markup or a name the site never rendered as a label", () => {
    expect(() => projectPublicMoodleParticipantEnrolment({
      ...enrolmentBody,
      enrolment_count: 1,
      enrolments: [{ method: "Manual enrolments", status: "Active\nJane Moodle", start: null, end: null }],
      learner: { learnerToken: TOKENS[0] },
    }, { courseId: 2 })).toThrow("moodle_participant_enrolment_invalid");
    expect(() => projectPublicMoodleParticipantEnrolment({
      ...enrolmentBody,
      enrolment_count: 1,
      enrolments: [{ method: "Manual enrolments", status: "Active", start: null, end: null, note: "extra" }],
      learner: { learnerToken: TOKENS[0] },
    }, { courseId: 2 })).toThrow("moodle_participant_enrolment_invalid");
  });
});
