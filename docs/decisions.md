# Siluet decisions

## D1 · One creator on one machine

Approved by the owner on 2026-11-21. Siluet serves a single creator over loopback. They supply their own API credentials, choose when to spend on their provider account, and control their locally saved media. Keys stay on the server side of the local application. The selected provider receives the inputs required for the requested operation.

Keeping credentials, charges and files under one person's control avoids shared billing and asset permissions. The tradeoff is that the creator works on the machine running Siluet. Access from another device would require a new product decision.

A successful first session takes a creator from selecting a model and understanding its required inputs to submitting a generation, following the job, saving the result and finding it again when they reopen Siluet. If acknowledgement is lost, Siluet must distinguish an uncertain submission from a confirmed provider failure. The creator decides whether to risk another charge.

### Owner sign-in

Claim one owner with a single-use console token, then set a local password and optionally enroll an authenticator. Settings can link OIDC or direct LDAP independently to that owner. Before disabling a method, require a fresh sign-in through a remaining method, including enrolled MFA. Remove the local password hash and revoke its sessions when the creator disables password sign-in. Enforce the last-method check atomically. An explicit offline host recovery restores access to the existing studio. Bind OIDC to issuer and subject and verify signed authentication time for sensitive changes. Bind LDAP to an immutable directory ID over validated TLS. Apply enrolled MFA to all methods. Verify that a Tinyauth username cannot be reassigned before relying on its subject.

## D2 · Full image and video model coverage

Approved by the owner on 2026-11-21. Siluet aims to support the image and video models of ToAPIs and Poyo.ai, including the operations and input options each exposes. A creator can use either platform independently. Text prompts, captions and other documented inputs belong to the image or video operation that accepts them. Standalone text models and other non-media model catalogs are outside this scope.

Track coverage by provider, model and operation so that one supported model cannot be mistaken for support for a provider's entire catalog. Official provider sources establish capabilities. Record gaps and unknowns explicitly. This is the coverage target for future modules.

Media submissions carry the creator’s preference to turn off optional NSFW filtering. PoYo receives `input.enable_safety_checker: false`. On ToAPIs, `disable_nsfw: false` permits fallback where the account and region qualify. Show known schema conflicts before queuing and preserve any rejection without silently removing a field and resubmitting.

## D3 · Local persistence with embedded Turso and Drizzle

Approved by the owner on 2026-11-21. The first approved feature that needs persistence will use embedded Turso through Drizzle ORM. An embedded database keeps setup local to the creator’s machine and requires no separate database service. Drizzle gives the TypeScript application typed queries. Each module’s spec will define the data it needs to retain.
