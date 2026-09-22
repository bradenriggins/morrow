# Not cleared for inclusion on the evidence reviewed

## Connect and MindTap inclusion review

**Date:** 2026-09-05  
**Status:** Not cleared for inclusion on the evidence reviewed.

## Scope and limits

This is a read-only U.S.-focused research review for the proposed inclusion of
existing McGraw Hill Connect and Cengage MindTap capabilities in a new Morrow
release. It considers public provider terms, public integration guidance, the
known provenance of the retained material, and limited copyright, DMCA, and
CFAA boundaries. It does not decide a final legal question.

The executed institutional agreement, purchase order, provider addenda, LTI
configuration terms, and developer or partner agreements were not inspected.
Those documents can control. In particular, McGraw Hill's public Terms of Use
state that a separate institutional agreement with substantially similar terms
governs instead. A provider agreement can grant rights beyond public terms, or
can impose stricter limits. Counsel and the provider must review the actual
agreement before a product decision.

## Current source and product position

Morrow currently excludes MindTap and Connect. `LIMITATIONS.md` says they are
not supported, listed, or callable. `SOURCE-ORIGIN.md` also prohibits harvested
MindTap or Connect methods and copied private source in a public candidate. The
standalone architecture treats provider-policy and source-rights review as
publication gates. Its public source-rights gate requires a permitted
disposition and exact digest record for each included file; the current manifest
has no provider-specific record. This is an engineering and release-policy
decision. It is not, by itself, a judicial finding that all provider integration
is unlawful.

The provenance weighs against an exception under the current gate. ExamplePlatform's
Connect material includes a smaller bundled contract set, while its recipe
describes a larger catalog obtained through browser-session capture and bundle
analysis. The client uses a fixed Connect host and replays an authenticated
session for non-dry-run operation. The MindTap planning material identifies an
authenticated OpenAPI resource and cookie plus CSRF/XSRF session behavior; it
contains no license or redistribution record. These facts do not establish that
either interface is a licensed public API. They also make public redistribution
different from independently implementing an interface from a published
provider contract.

No endpoint list, request schema, header recipe, session behavior, or captured
catalog is reproduced in this review.

## Provider terms and official integration paths

### McGraw Hill Connect

[McGraw Hill Terms of Use](https://www.mheducation.com/about-us/policy-center/terms-use)
were last updated April 24, 2026. The public license is limited,
non-exclusive, non-transferable, and for the user's internal educational use.
It requires individual account use and prohibits copying, derivative works,
systematic retrieval, reverse engineering, bypassing technical limits, and
automatic access. It also prohibits enabling “third party software, browser
extension, agent” to access or interact with the service. The separate
[Terms of Service](https://www.mheducation.com/about-us/policy-center/terms-service.html)
bind a subscriber and its representatives, including third-party service
providers, and prohibit robots, automatic devices, and copying or reproducing
the solution or content. It also says use is through an access method offered
by McGraw Hill and selected by the subscriber.

McGraw Hill publicly documents an administrator-configured
[LTI Advantage integration](https://www.mheducation.com/highered/services/learning-management-system-integration)
for Connect. It describes SSO, assignment-level linking, and gradebook sync.
Its [administrator guidance](https://www.mheducation.com/highered/support/knowledge/ltia-admin)
requires LMS configuration and identifies the LTI 1.3 integration and its
REST/OAuth components. This is evidence of a supported integration path. It is
not permission to reuse session-harvested Connect routes, support unrestricted
authoring, or redistribute a captured contract catalog.

### Cengage MindTap

[Cengage Higher Education Terms of Service](https://www.cengagegroup.com/legal/)
were last updated November 2025. They make an account personal and make the
faculty license limited, non-transferable, and only for educational instruction.
They restrict commercial exploitation, redistribution, source-code extraction,
reverse engineering, and tampering with digital-rights-management technology.
They also prohibit access to service or content through automated means,
including scripts, robots, spiders, and crawlers, and prohibit bypassing the
service navigation structure. Cengage permits narrowly defined faculty use of
materials in an adopted course for individually authenticated enrolled students;
that is not a commercial adapter license.

The same terms distinguish MindTap **Developer Offerings** from normal service
use. A Developer Offering is governed by separate terms supplied with its order
or activation. Cengage may provide developer offerings with identity,
institution, and course data, making a data agreement material as well as an
API license. Public terms do not show that the retained MindTap interface has
Developer Offering status.

[MindTap LTI Advantage guidance](https://help.cengage.com/mindtap/mt-instructor/common/lms-ltiadv-create-or-link-a-course.html)
says that the LMS administrator must set up the Cengage tool. The documented
outcomes are learner and instructor access through the LMS and score sync. This
is not an unrestricted authorization to call internal APIs, preserve cookies,
or use copied specifications in a separate product.

## Legal distinctions

An endpoint's functional facts, such as a route purpose or HTTP method, can be
an unprotected procedure or method of operation under
[17 U.S.C. § 102(b)](https://uscode.house.gov/view.xhtml?edition=prelim&req=granuleid%3AUSC-prelim-title17-section102%28b%29).
That rule does not grant access to a service. It does not authorize breach of a
provider contract. It also does not make every expression around an interface
free to copy.

Copied OpenAPI documents, prose documentation, bundled client code, examples,
field descriptions, selected and arranged catalogs, and provider course or
assessment content can contain protected expression. Copyright owners retain
the rights to reproduce, prepare derivatives, and distribute protected works
under [17 U.S.C. § 106](https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title17-section106).
[Google LLC v. Oracle America, Inc.](https://www.supremecourt.gov/opinions/20pdf/18-956diff_2024.pdf)
(Apr. 5, 2021) was a fact-specific fair-use holding for limited API declaring
code in a different platform. It did not grant a general right to copy private
service interfaces, avoid provider terms, or distribute provider content.

The anti-circumvention rule in
[17 U.S.C. § 1201](https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title17-section1201)
applies where an effective technological measure controls access to a protected
work. Its interoperability exception is narrow: the user must lawfully have the
right to use the program, act only to identify necessary unavailable elements,
and avoid infringement. It is not a general right to bypass session, token,
CSRF, or permission controls. It does not by its terms settle contract or
redistribution exposure.

The CFAA prohibits access without authorization and access to information that
the accessor is not entitled to obtain. In
[Van Buren v. United States](https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf)
(June 3, 2021), the Supreme Court rejected treating every improper use of data
that a person may access as an `exceeds authorized access` violation. The Court
did not decide whether the relevant access boundary comes only from code or may
also come from a contract or policy. Thus a terms violation alone is not an
automatic CFAA result, but use beyond a user, account, resource, or revoked
access boundary has a materially different risk profile.

## Conditional recommendation

Keep the present Connect and MindTap exclusion for public and commercial Morrow
release candidates. Do not include the retained adapter, captured catalog,
private schema, or browser-session method in the new Morrow without applicable
authorization. This review does not decide whether an existing institutional
ExamplePlatform deployment is permitted under its own agreement. This is the minimum result
that complies with the current Morrow source policy and avoids relying on a
public-terms exception that the evidence does not supply.

If Morrow later pursues support, use one of two paths. First, implement only an
official provider-enabled LTI path, after the institution administrator and
provider authorize it. Second, obtain a written provider developer or partner
agreement that expressly permits the exact product, commercial distribution,
API/LTI scope, client or hosted architecture, caching, data handling,
documentation use, and termination behavior. Counsel should compare that
agreement with the retained material before any code, catalog, documentation,
or product claim is admitted to a release candidate.
