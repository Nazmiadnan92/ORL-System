# ORL OT Management System

A web-based operating theatre scheduling and patient request management system developed for the Department of Otorhinolaryngology.

The system provides a structured workflow for managing OT requests, patient scheduling, approvals, postponements, cancellations, and operational records through role-based access.

## Key Features

- Interactive OT schedule with year and month navigation
- Direct OT slot requests
- Patient search using MRN
- Automatic patient age calculation from Malaysian IC
- Staff request review and approval
- OT slot confirmation, editing, postponement, and reassignment
- Controlled cancellation and deletion approval workflow
- OT slot closure and reopening
- Public holiday and blocked-date management
- Automatic Malaysia and Kedah public holiday generation
- Special OT day titles and date navigation
- Printable OT list generation
- Postponement history and counter
- Duplicate patient request detection
- Audit logging
- User and role management
- Personal colour themes
- Responsive desktop and mobile interface
- Encrypted database backup and restore

## User Roles

### Staff

Staff members can:

- Submit OT requests
- Select available Main OT slots
- View their requests and OT schedules
- Edit permitted clinical information
- Request cancellation or deletion
- Postpone eligible cases

### Admin

Administrators can:

- Review and approve staff requests
- Manage scheduled cases
- Confirm, edit, postpone, reassign, or cancel cases
- Close or reopen available OT slots
- Manage holidays and blocked dates
- Review cancellation and deletion requests
- Generate OT lists

### Webmaster

The Webmaster has full administrative access, including:

- All Admin capabilities
- User account management
- Database health and repair tools
- Duplicate and orphan record checks
- Audit log cleanup
- Patient record removal
- Encrypted backup export and restore
- Security confirmation for sensitive operations

## Technology

- HTML5
- CSS3
- Vanilla JavaScript
- Supabase PostgreSQL
- Supabase RPC functions
- Row Level Security
- GitHub Pages

## Security

The application uses role-based permissions and protected database functions for sensitive operations.

Webmaster-level actions require additional password confirmation. Backup files are compressed and encrypted before download using a user-provided passphrase.

Passwords, private credentials, and service-role keys must never be committed to this repository.

## Backup and Recovery

The Webmaster can export an encrypted `.orlbackup` file containing operational data, including:

- Patient requests
- OT sessions and slots
- Holidays and blocked dates
- System settings
- Postponement and cancellation records
- Audit logs

Existing login accounts and passwords are preserved during restoration.

The backup passphrase is required to restore the file and cannot be recovered by the system.

## Deployment

The browser application is located in the `docs` directory and can be hosted using GitHub Pages or another static web-hosting provider.

Database functions and updates are maintained as numbered SQL migration files inside the `supabase` directory.

Only the Supabase public publishable key should be used in browser configuration. Never expose a Supabase `service_role` key in client-side code.

## Important Notice

This system is intended to support internal OT scheduling workflows. Appropriate organisational approval, access controls, backup procedures, and patient-data protection policies must be established before use with real clinical information.

## Project Status

Actively maintained and continuously improved based on departmental workflow requirements.
