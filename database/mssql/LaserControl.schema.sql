/*
  Canonical MSSQL bootstrap schema for Registros Automaticos.
  Preferred path for real operation:
  1. Restore the current .bak from mssql-backups/
  2. Use this schema file only when you need a fresh empty database

  Notes:
  - No foreign keys are created here because the current live MSSQL
    database does not enforce them.
  - The app can continue bootstrap logic through db_mssql.js on first run.
*/

IF DB_ID(N'LaserControl') IS NULL
BEGIN
    CREATE DATABASE [LaserControl];
END
GO

USE [LaserControl];
GO

IF OBJECT_ID(N'dbo.lotes', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.lotes (
        id NVARCHAR(255) NOT NULL PRIMARY KEY,
        name NVARCHAR(255) NOT NULL,
        [process] NVARCHAR(50) NOT NULL CONSTRAINT DF_lotes_process DEFAULT ('all'),
        created_at DATETIME2 NOT NULL CONSTRAINT DF_lotes_created_at DEFAULT (SYSUTCDATETIME()),
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_lotes_updated_at DEFAULT (SYSUTCDATETIME()),
        metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_lotes_metadata DEFAULT ('{}')
    );
END
GO

IF OBJECT_ID(N'dbo.pieces', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.pieces (
        uid NVARCHAR(450) NOT NULL PRIMARY KEY,
        lot_id NVARCHAR(450) NOT NULL,
        partNumber NVARCHAR(255) NULL,
        quantity INT NOT NULL CONSTRAINT DF_pieces_quantity DEFAULT ((0)),
        incidents INT NOT NULL CONSTRAINT DF_pieces_incidents DEFAULT ((0)),
        incidentType NVARCHAR(255) NOT NULL CONSTRAINT DF_pieces_incidentType DEFAULT (''),
        [timestamp] DATETIME2 NOT NULL CONSTRAINT DF_pieces_timestamp DEFAULT (SYSUTCDATETIME()),
        imagen NVARCHAR(MAX) NULL,
        sourceFile NVARCHAR(255) NULL,
        clientId NVARCHAR(450) NULL,
        messageId NVARCHAR(450) NULL,
        proceso NVARCHAR(255) NOT NULL CONSTRAINT DF_pieces_proceso DEFAULT (''),
        metadata NVARCHAR(MAX) NOT NULL CONSTRAINT DF_pieces_metadata DEFAULT ('{}')
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_pieces_lot_id' AND object_id = OBJECT_ID(N'dbo.pieces'))
BEGIN
    CREATE INDEX idx_pieces_lot_id ON dbo.pieces (lot_id);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_pieces_messageId' AND object_id = OBJECT_ID(N'dbo.pieces'))
BEGIN
    CREATE INDEX idx_pieces_messageId ON dbo.pieces (messageId);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_pieces_clientId' AND object_id = OBJECT_ID(N'dbo.pieces'))
BEGIN
    CREATE INDEX idx_pieces_clientId ON dbo.pieces (clientId);
END
GO

IF OBJECT_ID(N'dbo.lot_metrics', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.lot_metrics (
        id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        lot_id NVARCHAR(450) NOT NULL,
        metric_type NVARCHAR(50) NOT NULL,
        data NVARCHAR(MAX) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_lot_metrics_created_at DEFAULT (SYSUTCDATETIME()),
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_lot_metrics_updated_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT UQ_lot_metrics UNIQUE (lot_id, metric_type)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_lot_metrics_lot_id' AND object_id = OBJECT_ID(N'dbo.lot_metrics'))
BEGIN
    CREATE INDEX idx_lot_metrics_lot_id ON dbo.lot_metrics (lot_id);
END
GO

IF OBJECT_ID(N'dbo.sync_log', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.sync_log (
        id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        action NVARCHAR(255) NULL,
        entity_type NVARCHAR(255) NULL,
        entity_id NVARCHAR(255) NULL,
        data NVARCHAR(MAX) NULL,
        status NVARCHAR(50) NOT NULL CONSTRAINT DF_sync_log_status DEFAULT ('pending'),
        created_at DATETIME2 NOT NULL CONSTRAINT DF_sync_log_created_at DEFAULT (SYSUTCDATETIME()),
        synced_at DATETIME2 NULL
    );
END
GO

IF OBJECT_ID(N'dbo.monthly_snapshots', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.monthly_snapshots (
        id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        [month] INT NOT NULL,
        [year] INT NOT NULL,
        report_type NVARCHAR(50) NOT NULL CONSTRAINT DF_monthly_snapshots_report_type DEFAULT ('all'),
        label NVARCHAR(255) NOT NULL,
        snapshot_data NVARCHAR(MAX) NOT NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_monthly_snapshots_created_at DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT UQ_monthly_snapshots UNIQUE ([month], [year], report_type)
    );
END
GO

IF OBJECT_ID(N'dbo.auth_users', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.auth_users (
        id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        username NVARCHAR(255) NOT NULL UNIQUE,
        password_hash NVARCHAR(255) NOT NULL,
        role NVARCHAR(50) NULL CONSTRAINT DF_auth_users_role DEFAULT ('viewer'),
        permissions_json NVARCHAR(MAX) NULL CONSTRAINT DF_auth_users_permissions_json DEFAULT ('[]'),
        active INT NULL CONSTRAINT DF_auth_users_active DEFAULT ((1)),
        created_at DATETIME2 NOT NULL CONSTRAINT DF_auth_users_created_at DEFAULT (SYSUTCDATETIME()),
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_auth_users_updated_at DEFAULT (SYSUTCDATETIME())
    );
END
GO

IF OBJECT_ID(N'dbo.system_kv', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.system_kv (
        [key] NVARCHAR(255) NOT NULL PRIMARY KEY,
        [value] NVARCHAR(MAX) NULL,
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_system_kv_updated_at DEFAULT (SYSUTCDATETIME())
    );
END
GO
