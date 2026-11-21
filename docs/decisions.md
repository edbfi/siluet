# Siluet decisions

## D1 · One creator on one machine

Approved by the owner on 2026-11-21. Siluet serves a single creator over loopback. They supply their own API credentials, choose when to spend on their provider account, and control their locally saved media. Keys stay on the server side of the local application. The selected provider receives the inputs required for the requested operation.

Keeping credentials, charges and files under one person's control avoids shared billing and asset permissions. The tradeoff is that the creator works on the machine running Siluet. Access from another device would require a new product decision.

A successful first session takes a creator from selecting a model and understanding its required inputs to submitting a generation, following the job, saving the result and finding it again when they reopen Siluet. If acknowledgement is lost, Siluet must distinguish an uncertain submission from a confirmed provider failure. The creator decides whether to risk another charge.

### Credit estimates

Calculate estimates locally so creators can review spending offline. Publish public rates through the repository to limit traffic to each provider. Show an unknown total when the price evidence is 30 days old or the rates do not cover the selected options. Keep any provider-reported charge separate from the estimate. A before-and-after wallet reading shows account-wide movement during a batch. Top-ups, reservations and other clients can change that balance. Show the movement separately from settlement and withhold comparisons for overlapping batches.

An unresolved Poyo.ai submission may still debit the same wallet after a key change. While its outcome is unknown, withhold later wallet comparisons across key revisions. The provider’s media retention period gives no deadline for settlement. Estimates and provider-reported task credits remain available independently.

### Owner sign-in

Claim one owner with a single-use console token, then set a local password and optionally enroll an authenticator. Settings can link OIDC and direct LDAP independently to that owner, with guided OIDC setup for Tinyauth, Authelia and authentik. Authorize method changes by reauthenticating through a currently enabled method, including enrolled MFA. Before activating a new or replacement binding, complete a sign-in through that exact candidate. Before disabling or replacing a method, also require fresh proof through a method that will remain enabled. One sign-in can satisfy both checks when the same method and configuration survive the change. Remove the local password hash and revoke its sessions when the creator disables password sign-in. Bind the single-use, short-lived proof to the initiating browser session, exact change and the configurations being verified. In one transaction consume the proof, apply the change and enforce the last-method check. An explicit offline host recovery restores access to the existing studio. Bind OIDC to issuer and subject and verify signed authentication time for sensitive changes. Bind LDAP to an immutable directory ID over validated TLS. Apply enrolled MFA to all methods. Verify that a Tinyauth username cannot be reassigned before relying on its subject.

## D2 · Full image and video model coverage

Approved by the owner on 2026-11-21. Siluet aims to support the image and video models of ToAPIs and Poyo.ai, including the operations and input options each exposes. A creator can use either platform independently. Text prompts, captions and other documented inputs belong to the image or video operation that accepts them. Standalone text models and other non-media model catalogs are outside this scope.

Track coverage by provider, model and operation so that one supported model cannot be mistaken for support for a provider's entire catalog. Official provider sources establish capabilities. Record gaps and unknowns explicitly. This is the coverage target for future modules.

## D3 · Local persistence with embedded Turso and Drizzle

Approved by the owner on 2026-11-21. The first approved feature that needs persistence will use embedded Turso through Drizzle ORM. An embedded database keeps setup local to the creator’s machine and requires no separate database service. Drizzle gives the TypeScript application typed queries. Each module’s spec will define the data it needs to retain.

## D4 · Optional filtering on media requests

Siluet uses a fixed default for image and video generation and edits so switching models keeps the single creator’s chosen filtering policy. The composer sends `input.enable_safety_checker: false` to Poyo.ai and `disable_nsfw: false` to ToAPIs. On eligible ToAPIs accounts and regions the latter permits fallback. Show known schema conflicts before queuing. Preserve a rejection because dropping a field and resubmitting could change the result and incur a second charge.

## D5 · Verify Gallery images before saving

A damaged image can have valid dimensions and headers. Gallery needs a complete pixel decode and access to decoder warnings. Bun 1.4.5 exposes metadata and encoded output. Use sharp with libvips to verify every pixel within the size limits and reject warnings before publishing the original PNG or JPEG bytes.
