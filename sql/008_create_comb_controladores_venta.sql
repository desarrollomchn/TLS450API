-- Credenciales de controladores de venta (VOX / FUSION / ALVIC / futuros) por estación.
-- Tabla separada de comb_estaciones a propósito: distinto nivel de sensibilidad
-- (credenciales cifradas) y relación opcional/dispersa (no todas las estaciones
-- tienen controlador de venta relevado todavía).
--
-- FK contra gen_estaciones(Id), NO contra comb_estaciones(Id) — mismo motivo que
-- comb_capacidades (migración 005): comb_estaciones existe específicamente para
-- estaciones con Veeder-Root instalado, y la mayoría de las estaciones con VOX/Fusion
-- todavía no lo tienen (confirmado contra "Controladores de venta EDS copemsa y Jade
-- Masis.xlsx" — de 34 estaciones, solo ~13 tienen columna VEEDER con dato real).

CREATE TABLE comb_controladores_venta (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    EstacionId INT NOT NULL,
    Sistema VARCHAR(20) NOT NULL,
    Ip VARCHAR(50) NOT NULL,
    Usuario VARCHAR(100) NOT NULL,
    PasswordCifrado VARBINARY(MAX) NOT NULL,
    Iv VARBINARY(16) NOT NULL,
    AuthTag VARBINARY(16) NOT NULL,
    Activo BIT NOT NULL DEFAULT 1,
    CONSTRAINT FK_comb_controladores_venta_gen_estaciones FOREIGN KEY (EstacionId) REFERENCES gen_estaciones(Id),
    CONSTRAINT UQ_comb_controladores_venta_EstacionId UNIQUE (EstacionId)
);
GO
