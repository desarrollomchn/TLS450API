-- Capacidad de tanques por estación y producto, editable sin redeploy
-- (reemplaza al viejo config/tanks.json, que solo describía una estación).

CREATE TABLE comb_capacidades (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    ComEstacionId INT NOT NULL,
    Producto VARCHAR(20) NOT NULL,
    CapacidadGalones DECIMAL(10,2) NOT NULL,
    CONSTRAINT FK_comb_capacidades_comb_estaciones FOREIGN KEY (ComEstacionId) REFERENCES comb_estaciones(Id),
    CONSTRAINT UQ_comb_capacidades_Estacion_Producto UNIQUE (ComEstacionId, Producto)
);
GO
