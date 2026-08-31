-- Re-crea comb_capacidades con la clave correcta: EstacionId (gen_estaciones.Id) en vez
-- de ComEstacionId (comb_estaciones.Id). La capacidad de tanque es una propiedad de la
-- estación física, independiente de si ya tiene hardware Veeder-Root instalado — con la
-- FK vieja, las 24 estaciones reales sin fila en comb_estaciones (comb_estaciones.Host es
-- NOT NULL y no tienen IP real) no podían tener capacidad cargada. comb_capacidades se creó
-- en esta misma sesión de trabajo y no tiene otros consumidores, así que es seguro recrearla.

IF OBJECT_ID('comb_capacidades', 'U') IS NOT NULL
    DROP TABLE comb_capacidades;
GO

CREATE TABLE comb_capacidades (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    EstacionId INT NOT NULL,
    Producto VARCHAR(20) NOT NULL,
    CapacidadGalones DECIMAL(10,2) NOT NULL,
    CONSTRAINT FK_comb_capacidades_gen_estaciones FOREIGN KEY (EstacionId) REFERENCES gen_estaciones(Id),
    CONSTRAINT UQ_comb_capacidades_Estacion_Producto UNIQUE (EstacionId, Producto)
);
GO
