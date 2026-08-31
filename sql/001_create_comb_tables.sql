-- Tablas de monitoreo de combustible (Veeder-Root / TLS-450 PLUS)
-- Prefijo comb_ (categoría: combustible), siguiendo la convención de gen_/auth_/it_

CREATE TABLE comb_estaciones (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    EstacionId INT NOT NULL,
    Host VARCHAR(50) NOT NULL,
    Activo BIT NOT NULL DEFAULT 1,
    CONSTRAINT FK_comb_estaciones_gen_estaciones FOREIGN KEY (EstacionId) REFERENCES gen_estaciones(Id),
    CONSTRAINT UQ_comb_estaciones_EstacionId UNIQUE (EstacionId)
);
GO

CREATE TABLE comb_tanques (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    ComEstacionId INT NOT NULL,
    TankNumber INT NOT NULL,
    Name NVARCHAR(50) NOT NULL,
    CapacityGallons DECIMAL(10,2) NOT NULL,
    LowLevelPercent DECIMAL(5,2) NOT NULL DEFAULT 20,
    CONSTRAINT FK_comb_tanques_comb_estaciones FOREIGN KEY (ComEstacionId) REFERENCES comb_estaciones(Id),
    CONSTRAINT UQ_comb_tanques_Estacion_Tank UNIQUE (ComEstacionId, TankNumber)
);
GO

CREATE TABLE comb_lecturas (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    TanqueId INT NOT NULL,
    Product VARCHAR(50) NULL,
    VolumeGallons DECIMAL(10,2) NULL,
    HeightInches DECIMAL(10,2) NULL,
    WaterInches DECIMAL(10,2) NULL,
    TemperatureF DECIMAL(6,2) NULL,
    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
    CONSTRAINT FK_comb_lecturas_comb_tanques FOREIGN KEY (TanqueId) REFERENCES comb_tanques(Id)
);
GO
CREATE INDEX IX_comb_lecturas_TanqueId_CreatedAt ON comb_lecturas(TanqueId, CreatedAt DESC);
GO

CREATE TABLE comb_alertas (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    TanqueId INT NOT NULL,
    VolumeGallons DECIMAL(10,2) NULL,
    PercentageLevel DECIMAL(5,2) NULL,
    SentAt DATETIME NOT NULL DEFAULT GETDATE(),
    CONSTRAINT FK_comb_alertas_comb_tanques FOREIGN KEY (TanqueId) REFERENCES comb_tanques(Id)
);
GO
CREATE INDEX IX_comb_alertas_TanqueId_SentAt ON comb_alertas(TanqueId, SentAt DESC);
GO
